package plugins

import "testing"

const page = `<!doctype html><html><head><title>Fight Club</title></head><body>
<div id="main" class="box wide" data-id="42" data-info='{"year":1999}'>
  <h1>Fight Club <small>(1999)</small></h1>
  <ul class="links">
    <li class="link hd"><a href="/v/1" data-quality="1080p">Server 1</a></li>
    <li class="link"><a href="/v/2" data-quality="720p">Server 2</a></li>
    <li class="link dead"><a href="/v/3">Server 3</a></li>
  </ul>
  <select name="season"><option value="1">S1</option><option value="2" selected>S2</option></select>
  <textarea>notes</textarea>
  <input name="token" value="abc">
  <script>var player = { file: "https://cdn.test/master.m3u8" };</script>
  <!-- a comment -->
</div>
</body></html>`

func withPage(t *testing.T, body string) string {
	t.Helper()
	return evalJS(t, "const cheerio = require(\"cheerio-without-node-native\"); const $ = cheerio.load("+jsString(page)+");"+body)
}

func jsString(s string) string {
	out := []rune{'"'}
	for _, r := range s {
		switch r {
		case '"', '\\':
			out = append(out, '\\', r)
		case '\n':
			out = append(out, '\\', 'n')
		default:
			out = append(out, r)
		}
	}
	return string(append(out, '"'))
}

func TestCheerio(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"title", `return $("title").text();`, `"Fight Club"`},
		{"length and attr", `return [$("li.link").length, $("li.hd a").attr("href"), $("li a").attr("data-quality")];`, `[3,"/v/1","1080p"]`},
		{"missing attr", `return [$("li.dead a").attr("data-quality") === undefined, $(".nothing").attr("x") === undefined];`, `[true,true]`},
		{"map get", `return $("li a").map((i, el) => $(el).attr("href")).get();`, `["/v/1","/v/2","/v/3"]`},
		{"map toArray", `return $("li a").map(function () { return $(this).text(); }).toArray();`, `["Server 1","Server 2","Server 3"]`},
		{"each with this", `const out = []; $("li").each(function (i, el) { out.push(i + ":" + $(this).find("a").text() + ":" + (this === el)); }); return out;`,
			`["0:Server 1:true","1:Server 2:true","2:Server 3:true"]`},
		{"each stops on false", `let n = 0; $("li").each(() => { n++; return false; }); return n;`, `1`},
		{"find and context", `return [$("#main").find("a").length, $("a", "ul.links").length, $("a", $("li.hd")).length];`, `[3,3,1]`},
		{"first last eq", `return [$("li").first().text(), $("li").last().text(), $("li").eq(1).text(), $("li").eq(-1).text(), $("li").eq(9).length];`,
			`["Server 1","Server 3","Server 2","Server 3",0]`},
		{"filter and not", `return [$("li").filter(".hd").length, $("li").not(".dead").length, $("li").filter((i, el) => i > 0).length];`, `[1,2,2]`},
		{"is and hasClass", `return [$("li").first().is(".hd"), $("#main").hasClass("wide"), $("#main").hasClass("narrow")];`, `[true,true,false]`},
		{"parent parents closest", `const a = $("li.hd a"); return [a.parent().attr("class"), a.closest("ul").attr("class"), a.parents("div").attr("id"), a.parents().length];`,
			`["link hd","links","main",5]`},
		{"siblings next prev", `const hd = $("li.hd"); return [hd.next().text(), hd.next().next().prev().text(), hd.siblings().length, hd.nextAll().length, $("li.dead").prevAll().length];`,
			`["Server 2","Server 2",2,2,2]`},
		{"children and contents", `return [$("ul").children().length, $("ul").children(".hd").length, $("h1").contents().length];`, `[3,1,2]`},
		{"has", `return $("li").has("a[data-quality]").length;`, `2`},
		{"text of many", `return $("h1").text();`, `"Fight Club (1999)"`},
		{"html", `return [$("h1").html(), $.html($("small"))];`, `["Fight Club <small>(1999)</small>","<small>(1999)</small>"]`},
		{"script text", `return /cdn\.test/.test($("script").html()) && /master/.test($("script").text());`, `true`},
		{"data", `return [$("#main").data("id"), $("#main").data("info").year, $("li a").first().data("quality"), Object.keys($("#main").data())];`,
			`[42,1999,"1080p",["id","info"]]`},
		{"val", `return [$("select").val(), $("textarea").val(), $("input[name=token]").val()];`, `["2","notes","abc"]`},
		{"element shape", `const el = $("li a").get(0); return [el.type, el.name, el.tagName, el.attribs.href, el.parent.name, el.children[0].type, el.children[0].data, el.nodeType];`,
			`["tag","a","a","/v/1","li","text","Server 1",1]`},
		{"wrap an element", `const el = $("li a")[1]; return $(el).text();`, `"Server 2"`},
		// x/net's parser sorts the attributes of formatting elements such as <a>
		// (the Noah's Ark clause, since v0.60), so they render alphabetically.
		{"set attr", `$("li a").first().attr("href", "/new"); return [$("li a").first().attr("href"), $.html($("li a").first())];`,
			`["/new","<a data-quality=\"1080p\" href=\"/new\">Server 1</a>"]`},
		{"fragment", `return [$("<p><b>bold</b></p>").find("b").text(), cheerio.load("<a href='x'>y</a>")("a").attr("href")];`, `["bold","x"]`},
		{"attribute selectors", `return [$("a[href^='/v/']").length, $("a[data-quality='720p']").text(), $("li:nth-child(2) a").text(), $("li:not(.dead)").length];`,
			`[3,"Server 2","Server 2",2]`},
		{"contains", `return $("a:contains('Server 3')").attr("href");`, `"/v/3"`},
		{"invalid selector throws", `try { $("li[") ; return "no"; } catch (e) { return "threw"; }`, `"threw"`},
		{"root and $.text", `return [$.root().find("li").length, $.text($("small"))];`, `[3,"(1999)"]`},
		{"esm interop default", `return typeof cheerio.default.load;`, `"function"`},
		{"iterate", `const out = []; for (const el of $("li a")) out.push(el.attribs.href); return out;`, `["/v/1","/v/2","/v/3"]`},
		{"end", `return $("ul").find("li").end().attr("class");`, `"links"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := withPage(t, tc.body); got != tc.want {
				t.Errorf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}
