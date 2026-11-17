//go:build ios

package iosplayer

import (
	"os"
	"path/filepath"
	"sync"
)

// chromaHook works around an mpv 0.41 bug that turned every zero-copy
// picture purple and green on a real device (the simulator can't map
// VideoToolbox frames, so it never showed there).
//
// iOS's texture cache only maps a frame's planes as GL_LUMINANCE and
// GL_LUMINANCE_ALPHA, so the nv12 chroma plane arrives as (U, U, U, V).
// mpv knows: its copy and hook paths read such a texture with the "raaa"
// swizzle. Its chroma scaler doesn't: pass_sample reads texture(tex, pos)
// as is, so V comes from .g, which holds U again, and Cr equals Cb.
//
// A hook on CHROMA makes mpv draw the plane through HOOKED_tex first, which
// applies the texture's own swizzle ("raaa" here, "rgba" for the uploaded
// textures of the copy and software modes), into a plain texture that the
// scaler then reads correctly. The pass is at chroma size: a quarter of the
// picture.
const chromaHook = `//!HOOK CHROMA
//!BIND HOOKED
//!DESC peli: chroma through its texture swizzle
vec4 hook() {
    return HOOKED_tex(HOOKED_pos);
}
`

var chromaShader = sync.OnceValues(func() (string, error) {
	path := filepath.Join(os.TempDir(), "peli-chroma.glsl")
	return path, os.WriteFile(path, []byte(chromaHook), 0o644)
})
