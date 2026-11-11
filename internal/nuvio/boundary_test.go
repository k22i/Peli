package nuvio

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The acceptance criterion of #28: no Supabase call exists outside this
// module. Go reaches Nuvio only through this package, and only the sync
// module and the account service import it; the frontend has no Supabase
// client at all, since tokens never reach the webview (ADR-0008).

// repoRoot is the module root, found from this package's directory.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("no go.mod at %s", root)
	}
	return root
}

// goFiles walks the app's Go source outside this package. Spikes, vendored
// code and the frontend's dependencies are not the app.
func goFiles(t *testing.T, root string, visit func(rel string, file *ast.File)) {
	t.Helper()
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			switch rel {
			case ".git", "spikes", "third_party", "internal/nuvio", "frontend/node_modules":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly|parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		visit(rel, file)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Only the sync module and the account service import the Nuvio client.
func TestOnlySyncModuleImportsNuvio(t *testing.T) {
	allowed := []string{"main.go", "internal/account/", "internal/backend/"}
	goFiles(t, repoRoot(t), func(rel string, file *ast.File) {
		for _, spec := range file.Imports {
			path, _ := strconv.Unquote(spec.Path.Value)
			if path != "github.com/k22i/Peli/internal/nuvio" && !strings.HasPrefix(path, "github.com/k22i/Peli/internal/nuvio/") {
				continue
			}
			if !slices.ContainsFunc(allowed, func(a string) bool { return rel == a || strings.HasSuffix(a, "/") && strings.HasPrefix(rel, a) }) {
				t.Errorf("%s imports %s: call Nuvio through internal/backend", rel, path)
			}
		}
	})
}

// Nothing outside this package names a Supabase endpoint or host, or imports
// a Supabase library.
func TestNoSupabaseOutsideNuvio(t *testing.T) {
	root := repoRoot(t)
	fset := token.NewFileSet()
	goFiles(t, root, func(rel string, file *ast.File) {
		for _, spec := range file.Imports {
			if path, _ := strconv.Unquote(spec.Path.Value); strings.Contains(path, "supabase") {
				t.Errorf("%s imports %s", rel, path)
			}
		}
		// Imports only above; the literals need the whole file.
		full, err := parser.ParseFile(fset, filepath.Join(root, rel), nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(full, func(n ast.Node) bool {
			if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
				if bad := forbidden(lit.Value); bad != "" {
					t.Errorf("%s: %s names %q: it belongs in internal/nuvio", rel, lit.Value, bad)
				}
			}
			return true
		})
	})

	for _, rel := range []string{"go.mod", "frontend/package.json"} {
		data, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.ToLower(string(data)), "supabase") {
			t.Errorf("%s depends on Supabase", rel)
		}
	}
	err := filepath.WalkDir(filepath.Join(root, "frontend", "src"), func(path string, d fs.DirEntry, err error) error {
		// Tests carry URLs the app was given, as fixtures.
		if err != nil || d.IsDir() || strings.Contains(d.Name(), ".test.") {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if bad := forbidden(string(data)); bad != "" || strings.Contains(strings.ToLower(string(data)), "supabase") {
			t.Errorf("%s names %q: the frontend never talks to Nuvio", filepath.ToSlash(rel), bad)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// forbidden returns the Supabase-shaped thing s mentions, or "".
func forbidden(s string) string {
	for _, bad := range []string{"/rest/v1", "/auth/v1", "/functions/v1", "/storage/v1", "/.well-known/nuvio", "supabase", "api.nuvio.tv"} {
		if strings.Contains(strings.ToLower(s), bad) {
			return bad
		}
	}
	return ""
}

// Home layout and collections are never pushed to the official backend
// (#30, #35): only home.go names their calls, and its pushes check
// OwnServer first (TestHomePushesRefuseNuviosServer).
func TestNoLayoutOrCollectionCalls(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") || name == "home.go" {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
				s := strings.ToLower(lit.Value)
				if strings.Contains(s, "collection") || strings.Contains(s, "layout") || strings.Contains(s, "home_catalog") {
					t.Errorf("%s: %s names home layout or collections outside home.go", fset.Position(lit.Pos()), lit.Value)
				}
			}
			return true
		})
	}
}
