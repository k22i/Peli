package shell

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"sort"
	"testing"
)

// platformFuncs lists a file's top-level functions (not methods, not
// cgo exports) by name, with their parameter and result counts.
func platformFuncs(t *testing.T, name string) (funcs map[string][2]int, methods []string) {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), name, nil, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	count := func(fl *ast.FieldList) int {
		n := 0
		if fl != nil {
			for _, f := range fl.List {
				n += max(1, len(f.Names))
			}
		}
		return n
	}
	funcs = map[string][2]int{}
	for _, d := range file.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok {
			continue
		}
		if fn.Recv != nil {
			methods = append(methods, fn.Name.Name)
			continue
		}
		if fn.Doc != nil && len(fn.Doc.List) > 0 && fn.Doc.List[0].Text[:min(9, len(fn.Doc.List[0].Text))] == "//export " {
			continue
		}
		funcs[fn.Name.Name] = [2]int{count(fn.Type.Params), count(fn.Type.Results)}
	}
	return funcs, methods
}

// The bound methods live in shell.go, the same on every platform: the
// frontend's bindings come from the desktop build and a method id hashes the
// package, type and name (ADR-0055). The platform files only fill in the
// same unexported helpers, so iOS can never bind a method the desktop
// lacks. A test can't build for iOS, so it reads the files.
func TestIOSServiceHasTheDesktopMethods(t *testing.T) {
	ios, iosMethods := platformFuncs(t, "shell_ios.go")
	desktop, desktopMethods := platformFuncs(t, "shell_other.go")
	for _, m := range append(iosMethods, desktopMethods...) {
		t.Errorf("method %s in a platform file: bound methods belong in shell.go", m)
	}
	if !reflect.DeepEqual(ios, desktop) {
		t.Errorf("platform helpers differ: iOS %v, desktop %v", ios, desktop)
	}

	var bound []string
	typ := reflect.TypeFor[*Service]()
	for i := range typ.NumMethod() {
		bound = append(bound, typ.Method(i).Name)
	}
	sort.Strings(bound)
	want := []string{"CameraAccess", "ScanQR", "ServiceStartup", "SetTabBar", "TabBarHeight"}
	if !reflect.DeepEqual(bound, want) {
		t.Errorf("bound methods %v, want %v (update the frontend and this test on purpose)", bound, want)
	}
}

func TestDesktopIsANoOp(t *testing.T) {
	var s Service
	if err := s.SetTabBar(TabBarState{Active: "/", Theme: "dark"}); err != nil {
		t.Fatal(err)
	}
	if h := s.TabBarHeight(); h != 0 {
		t.Errorf("TabBarHeight = %v on the desktop, want 0 (the frontend draws its own)", h)
	}
}
