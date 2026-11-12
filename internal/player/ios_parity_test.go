//go:build !ios

package player

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"sort"
	"testing"
)

// The iOS Service (service_ios.go) must bind the same methods as the libmpv
// one: the frontend's bindings come from this one, and a bound method's id
// hashes its package, type and name (ADR-0055). A test can't build for iOS,
// so it reads that file.
func TestIOSServiceHasTheDesktopMethods(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "service_ios.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	count := func(fl *ast.FieldList) int {
		n := 0
		if fl == nil {
			return 0
		}
		for _, f := range fl.List {
			n += max(1, len(f.Names))
		}
		return n
	}
	type shape struct{ in, out int }
	ios := map[string]shape{}
	for _, d := range file.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Recv == nil || !fn.Name.IsExported() {
			continue
		}
		star, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
		if !ok || star.X.(*ast.Ident).Name != "Service" {
			continue
		}
		ios[fn.Name.Name] = shape{count(fn.Type.Params), count(fn.Type.Results)}
	}

	desktop := map[string]shape{}
	typ := reflect.TypeFor[*Service]()
	for i := range typ.NumMethod() {
		m := typ.Method(i)
		desktop[m.Name] = shape{m.Type.NumIn() - 1, m.Type.NumOut()}
	}

	var names []string
	for name := range desktop {
		names = append(names, name)
	}
	for name := range ios {
		if _, ok := desktop[name]; !ok {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		d, dok := desktop[name]
		i, iok := ios[name]
		switch {
		case !dok:
			t.Errorf("%s is on the iOS Service only", name)
		case !iok:
			t.Errorf("%s is missing from the iOS Service (service_ios.go)", name)
		case d != i:
			t.Errorf("%s: desktop takes %d and returns %d, iOS %d and %d", name, d.in, d.out, i.in, i.out)
		}
	}
}
