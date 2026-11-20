package plugins

import (
	"fmt"
	"strings"

	"github.com/andybalholm/cascadia"
	"github.com/dop251/goja"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// maxDocuments caps the HTML documents one call may parse; maxSelectors
// the compiled selectors kept.
const (
	maxDocuments = 2_000
	maxSelectors = 1_000
)

// The HTML host behind cheerio-without-node-native (cheerio.js): Go parses
// and matches selectors, the JS side keeps the jQuery-like API. Nodes are
// numbers within their document; 0 is the document itself.
type document struct {
	nodes []*html.Node
	ids   map[*html.Node]int
}

func newDocument(root *html.Node) *document {
	d := &document{ids: map[*html.Node]int{}}
	d.id(root)
	return d
}

func (d *document) id(n *html.Node) int {
	if n == nil {
		return -1
	}
	if id, ok := d.ids[n]; ok {
		return id
	}
	d.ids[n] = len(d.nodes)
	d.nodes = append(d.nodes, n)
	return len(d.nodes) - 1
}

func (d *document) node(id int) *html.Node {
	if id < 0 || id >= len(d.nodes) {
		return nil
	}
	return d.nodes[id]
}

func (s *sandbox) selector(text string) (cascadia.Sel, error) {
	if sel, ok := s.selectors[text]; ok {
		return sel, nil
	}
	sel, err := cascadia.Parse(text)
	if err != nil {
		return nil, err
	}
	if len(s.selectors) < maxSelectors {
		s.selectors[text] = sel
	}
	return sel, nil
}

// installHTML adds host.html(markup, fragment) → a document's functions.
func (s *sandbox) installHTML(host *goja.Object) {
	host.Set("html", func(markup string, fragment bool) (*goja.Object, error) {
		if s.documents >= maxDocuments {
			return nil, errTooMany("HTML documents")
		}
		s.documents++
		var root *html.Node
		if fragment {
			body := &html.Node{Type: html.ElementNode, DataAtom: atom.Body, Data: "body"}
			nodes, err := html.ParseFragment(strings.NewReader(markup), body)
			if err != nil {
				return nil, err
			}
			root = &html.Node{Type: html.DocumentNode}
			for _, n := range nodes {
				root.AppendChild(n)
			}
		} else {
			var err error
			if root, err = html.Parse(strings.NewReader(markup)); err != nil {
				return nil, err
			}
		}
		return s.documentObject(newDocument(root)), nil
	})
}

func errTooMany(what string) error {
	return &limitError{"too many " + what}
}

type limitError struct{ msg string }

func (e *limitError) Error() string { return e.msg }

func (s *sandbox) documentObject(d *document) *goja.Object {
	vm := s.vm
	o := vm.NewObject()
	ids := func(nodes []*html.Node) []any {
		out := make([]any, len(nodes))
		for i, n := range nodes {
			out[i] = d.id(n)
		}
		return out
	}
	// select(ids, selector): the descendants of each that match, once
	// each, in document order.
	o.Set("select", func(from []int, text string) ([]any, error) {
		sel, err := s.selector(text)
		if err != nil {
			return nil, fmt.Errorf("invalid selector: %q", text)
		}
		seen := map[*html.Node]bool{}
		var found []*html.Node
		for _, id := range from {
			n := d.node(id)
			if n == nil {
				continue
			}
			for _, m := range cascadia.QueryAll(n, sel) {
				if !seen[m] {
					seen[m] = true
					found = append(found, m)
				}
			}
		}
		if len(from) > 1 {
			found = documentOrder(found)
		}
		return ids(found), nil
	})
	o.Set("matches", func(id int, text string) (bool, error) {
		sel, err := s.selector(text)
		if err != nil {
			return false, fmt.Errorf("invalid selector: %q", text)
		}
		n := d.node(id)
		return n != nil && n.Type == html.ElementNode && sel.Match(n), nil
	})
	// info(id): what an element object shows: type, name, attribs, data.
	o.Set("info", func(id int) goja.Value {
		n := d.node(id)
		if n == nil {
			return goja.Null()
		}
		info := vm.NewObject()
		switch n.Type {
		case html.DocumentNode:
			info.Set("type", "root")
			info.Set("name", "root")
		case html.ElementNode:
			// htmlparser2 (cheerio's parser) calls these "script" and "style".
			switch n.Data {
			case "script", "style":
				info.Set("type", n.Data)
			default:
				info.Set("type", "tag")
			}
			info.Set("name", n.Data)
			attribs := vm.NewObject()
			for _, a := range n.Attr {
				name := a.Key
				if a.Namespace != "" {
					name = a.Namespace + ":" + a.Key
				}
				attribs.Set(name, a.Val)
			}
			info.Set("attribs", attribs)
		case html.TextNode:
			info.Set("type", "text")
			info.Set("data", n.Data)
		case html.CommentNode:
			info.Set("type", "comment")
			info.Set("data", n.Data)
		case html.DoctypeNode:
			info.Set("type", "directive")
			info.Set("name", "!doctype")
			info.Set("data", "!DOCTYPE "+n.Data)
		default:
			info.Set("type", "text")
			info.Set("data", "")
		}
		return info
	})
	o.Set("parent", func(id int) int {
		if n := d.node(id); n != nil {
			return d.id(n.Parent)
		}
		return -1
	})
	o.Set("children", func(id int) []any {
		n := d.node(id)
		if n == nil {
			return nil
		}
		var out []any
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			out = append(out, d.id(c))
		}
		return out
	})
	o.Set("nextNode", func(id int) int {
		if n := d.node(id); n != nil {
			return d.id(n.NextSibling)
		}
		return -1
	})
	o.Set("prevNode", func(id int) int {
		if n := d.node(id); n != nil {
			return d.id(n.PrevSibling)
		}
		return -1
	})
	o.Set("text", func(id int) string {
		n := d.node(id)
		if n == nil {
			return ""
		}
		var b strings.Builder
		textOf(&b, n)
		return b.String()
	})
	// html(id): the markup inside; outer(id): the node's own.
	o.Set("html", func(id int) string {
		n := d.node(id)
		if n == nil {
			return ""
		}
		var b strings.Builder
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			_ = html.Render(&b, c)
		}
		return b.String()
	})
	o.Set("outer", func(id int) string {
		n := d.node(id)
		if n == nil {
			return ""
		}
		var b strings.Builder
		if n.Type == html.DocumentNode {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				_ = html.Render(&b, c)
			}
		} else {
			_ = html.Render(&b, n)
		}
		return b.String()
	})
	o.Set("setAttr", func(id int, name, value string, remove bool) {
		n := d.node(id)
		if n == nil || n.Type != html.ElementNode {
			return
		}
		for i, a := range n.Attr {
			if a.Key == name {
				if remove {
					n.Attr = append(n.Attr[:i], n.Attr[i+1:]...)
				} else {
					n.Attr[i].Val = value
				}
				return
			}
		}
		if !remove {
			n.Attr = append(n.Attr, html.Attribute{Key: name, Val: value})
		}
	})
	o.Set("remove", func(id int) {
		if n := d.node(id); n != nil && n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	})
	return o
}

// textOf is n's text, as cheerio's .text() gives it: every text node
// inside, scripts and styles included.
func textOf(b *strings.Builder, n *html.Node) {
	if n.Type == html.TextNode {
		b.WriteString(n.Data)
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		textOf(b, c)
	}
}

// documentOrder sorts nodes from one document by where they appear.
func documentOrder(nodes []*html.Node) []*html.Node {
	if len(nodes) < 2 {
		return nodes
	}
	in := map[*html.Node]bool{}
	for _, n := range nodes {
		in[n] = true
	}
	root := nodes[0]
	for root.Parent != nil {
		root = root.Parent
	}
	out := make([]*html.Node, 0, len(nodes))
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if in[n] {
			out = append(out, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return out
}
