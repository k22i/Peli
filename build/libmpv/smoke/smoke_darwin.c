// #92: smoke test for a macOS libmpv build. It checks the build has what
// Peli plays with, then renders each file it's given through the OpenGL
// render API (what internal/player's macOS host uses) in an offscreen CGL
// context, and fails unless a decoded frame reaches the framebuffer.
//
// What it is for is the build, not the host, and hosted Macs are short of
// both a GPU and a working VideoToolbox. Two allowances, both reported in the
// log rather than made quietly:
//
//   - a file that doesn't show with hardware decoding is played again with
//     `hwdec=no`. Software decoding is the bottom line: mpv always has it, and
//     this build's configure enables the decoders by hand.
//   - on a software renderer (Apple's, as hosted Macs get) no video reaches
//     the framebuffer — it draws the OSD and subtitles, nothing for a planar
//     yuv frame — so there the run asks only that mpv decodes each file and
//     asks for it to be rendered. The pixel check still applies to a real GPU.
//
//   smoke <file>...
//
// SMOKE_LOG sets mpv's log level (default warn).
//
// SMOKE_HWDEC overrides the first pass's `hwdec`, so the software retry can be
// run on a host whose hardware decoding works:
//
//   SMOKE_HWDEC=d3d11va ...  # not a macOS API: the first pass fails
//
// SMOKE_SOFTWARE_GL forces Apple's software renderer, which is how to see what
// a hosted Mac does on one with a GPU:
//
//   SMOKE_SOFTWARE_GL=1 build/libmpv/smoke.sh build/libmpv/.work/libmpv-macos-arm64
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mpv/client.h>
#include <mpv/render_gl.h>

enum { W = 320, H = 180 };

static int failed;

// soundChain is every audio filter the player uses (internal/player/sound.go)
// in one chain, set on every file: a filter missing from the build fails.
static const char *soundChain =
	"lavfi=[dialoguenhance=enhance=2,dynaudnorm=f=150:g=7:p=0.9:m=10,"
	"equalizer=f=1000:t=q:w=1:g=2,bass=g=3,treble=g=2,volume=1.0,pan=stereo|c0=c0|c1=c1]";

static void fail(const char *what, const char *detail) {
	fprintf(stderr, "FAIL %s: %s\n", what, detail);
	failed = 1;
}

static void check(int err, const char *what) {
	if (err < 0) {
		fprintf(stderr, "FAIL %s: %s\n", what, mpv_error_string(err));
		exit(1);
	}
}

static void *proc_address(void *ctx, const char *name) {
	(void)ctx;
	static void *gl;
	if (!gl)
		gl = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY);
	return dlsym(gl, name);
}

// want: every name in names must be in mpv's list property prop (a node list
// of maps with a "name" key, like decoder-list).
static void want(mpv_handle *mpv, const char *prop, const char *key, const char *const *names) {
	mpv_node list;
	check(mpv_get_property(mpv, prop, MPV_FORMAT_NODE, &list), prop);
	for (const char *const *n = names; *n; n++) {
		int found = 0;
		for (int i = 0; i < list.u.list->num && !found; i++) {
			mpv_node_list *m = list.u.list->values[i].u.list;
			for (int j = 0; j < m->num; j++)
				if (!strcmp(m->keys[j], key) && !strcmp(m->values[j].u.string, *n))
					found = 1;
		}
		if (!found)
			fail(prop, *n);
	}
	mpv_free_node_contents(&list);
}

// rendered: whether fbo holds anything but black.
static int rendered(GLuint fbo) {
	static unsigned char px[W * H * 4];
	glBindFramebuffer(GL_FRAMEBUFFER, fbo);
	glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
	for (size_t i = 0; i < sizeof px; i += 4)
		if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16)
			return 1;
	return 0;
}

// play renders path until a frame that isn't black reaches the framebuffer, and
// returns whether one did. hwdec picks this file's decoding: NULL keeps what the
// player set. Without pixels, which is all a software renderer can be held to,
// mpv asking for a frame is enough.
static int play(mpv_handle *mpv, mpv_render_context *rc, GLuint fbo, const char *path,
                const char *hwdec, int pixels) {
	// The option is read when the file loads, so setting it first applies here.
	if (hwdec)
		check(mpv_set_property_string(mpv, "hwdec", hwdec), "hwdec");
	const char *cmd[] = {"loadfile", path, NULL};
	check(mpv_command(mpv, cmd), "loadfile");
	int frames = 0, shown = 0;
	for (int i = 0; i < 400 && !shown; i++) {
		mpv_event *ev = mpv_wait_event(mpv, 0.05);
		if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
			mpv_event_log_message *msg = ev->data;
			fprintf(stderr, "[%s] %s: %s", msg->level, msg->prefix, msg->text);
			if (strstr(msg->text, "No such filter") || strstr(msg->text, "parsing the filter graph failed"))
				fail("af", msg->text);
		}
		if (ev->event_id == MPV_EVENT_END_FILE) {
			mpv_event_end_file *end = ev->data;
			if (end->reason == MPV_END_FILE_REASON_ERROR) {
				// A hardware decoder the host can't drive ends the file too,
				// which is why this is reported per attempt and not as a
				// failure: the caller retries in software before failing.
				fprintf(stderr, "FAIL %s: %s\n", path, mpv_error_string(end->error));
				break;
			}
		}
		if (!(mpv_render_context_update(rc) & MPV_RENDER_UPDATE_FRAME))
			continue;
		int flip = 1;
		mpv_opengl_fbo target = {.fbo = (int)fbo, .w = W, .h = H};
		mpv_render_param params[] = {
			{MPV_RENDER_PARAM_OPENGL_FBO, &target},
			{MPV_RENDER_PARAM_FLIP_Y, &flip},
			{0},
		};
		check(mpv_render_context_render(rc, params), "render");
		glFinish();
		frames++;
		shown = pixels ? rendered(fbo) : 1;
	}
	char *codec = mpv_get_property_string(mpv, "video-format");
	char *current = mpv_get_property_string(mpv, "hwdec-current");
	printf("%s: %d frames rendered, video %s, hwdec %s\n", path, frames, codec ? codec : "none",
	       current && *current ? current : "no");
	mpv_free(codec);
	mpv_free(current);
	const char *stop[] = {"stop", NULL};
	mpv_command(mpv, stop);
	return shown;
}

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr, "usage: smoke <file>...\n");
		return 2;
	}

	// Any renderer, software included: hosted Macs have no GPU.
	CGLPixelFormatAttribute anyRenderer[] = {
		kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
		kCGLPFAColorSize, 24, kCGLPFAAllowOfflineRenderers, 0,
	};
	// Apple's software renderer by name, which is what hosted Macs get:
	// SMOKE_SOFTWARE_GL asks for it, so a Mac with a GPU can see that case.
	CGLPixelFormatAttribute softwareRenderer[] = {
		kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
		kCGLPFAColorSize, 24, kCGLPFAAllowOfflineRenderers,
		kCGLPFARendererID, (CGLPixelFormatAttribute)kCGLRendererGenericFloatID, 0,
	};
	CGLPixelFormatObj pix;
	GLint npix;
	CGLContextObj gl;
	if (CGLChoosePixelFormat(getenv("SMOKE_SOFTWARE_GL") ? softwareRenderer : anyRenderer, &pix,
	                         &npix) ||
	    !pix || CGLCreateContext(pix, NULL, &gl))
		return fprintf(stderr, "FAIL: no OpenGL context\n"), 1;
	CGLSetCurrentContext(gl);
	const char *renderer = (const char *)glGetString(GL_RENDERER);
	printf("OpenGL: %s, %s\n", renderer, glGetString(GL_VERSION));
	// A software renderer draws no video (see the top of this file), so the
	// pixel check below can't run on one.
	int software = strstr(renderer, "Software") != NULL;
	if (software)
		printf("software renderer: checking that each file decodes and renders, not the pixels\n");

	GLuint fbo, tex;
	glGenTextures(1, &tex);
	glBindTexture(GL_TEXTURE_2D, tex);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
	glGenFramebuffers(1, &fbo);
	glBindFramebuffer(GL_FRAMEBUFFER, fbo);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
	if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
		return fprintf(stderr, "FAIL: framebuffer incomplete\n"), 1;

	mpv_handle *mpv = mpv_create();
	if (!mpv)
		return fprintf(stderr, "FAIL: mpv_create\n"), 1;
	check(mpv_set_option_string(mpv, "vo", "libmpv"), "vo");
	check(mpv_set_option_string(mpv, "ao", "null"), "ao");
	check(mpv_set_option_string(mpv, "hwdec", "videotoolbox,auto-safe"), "hwdec");
	check(mpv_set_option_string(mpv, "sid", "1"), "sid");
	check(mpv_set_option_string(mpv, "af", soundChain), "af");
	check(mpv_initialize(mpv), "mpv_initialize");
	check(mpv_request_log_messages(mpv, getenv("SMOKE_LOG") ? getenv("SMOKE_LOG") : "warn"), "log");

	char *version = mpv_get_property_string(mpv, "mpv-version");
	char *ffmpeg = mpv_get_property_string(mpv, "ffmpeg-version");
	printf("%s, FFmpeg %s\n", version, ffmpeg);
	mpv_free(version);
	mpv_free(ffmpeg);

	// What Peli's streams need (ticket #92): the common video codecs,
	// passthrough-capable audio, the subtitle formats addons and files carry,
	// and HTTPS for debrid links.
	// (decoder-list has audio and video only; the Matroska fixture's SubRip
	// track checks subtitles.)
	const char *const decoders[] = {"h264", "hevc", "av1", "libdav1d", "vp9", "vp8", "mpeg2video",
	                                "aac", "ac3", "eac3", "truehd", "dca", "flac", "opus", "vorbis",
	                                "mp3", NULL};
	want(mpv, "decoder-list", "driver", decoders);
	// Demuxers: playing the fixtures (MP4, Matroska, HLS) checks them.
	const char *const protocols[] = {"https", "http", "file", NULL};
	mpv_node list;
	check(mpv_get_property(mpv, "protocol-list", MPV_FORMAT_NODE, &list), "protocol-list");
	for (const char *const *p = protocols; *p; p++) {
		int found = 0;
		for (int i = 0; i < list.u.list->num; i++)
			found |= !strcmp(list.u.list->values[i].u.string, *p);
		if (!found)
			fail("protocol-list", *p);
	}
	mpv_free_node_contents(&list);

	mpv_render_context *rc;
	mpv_opengl_init_params init = {.get_proc_address = proc_address};
	mpv_render_param params[] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &init},
		{0},
	};
	check(mpv_render_context_create(&rc, mpv, params), "mpv_render_context_create");

	// hardware is the first pass's hwdec: the player's setting, unless
	// SMOKE_HWDEC names another one. soft records that this host has already
	// failed to hardware decode, so the rest play in software straight away.
	const char *hardware = getenv("SMOKE_HWDEC");
	int soft = 0;

	for (int i = 1; i < argc; i++) {
		int shown = play(mpv, rc, fbo, argv[i], soft ? "no" : hardware, !software);
		// Once a file needed software decoding, the rest do too: the host
		// can't hardware decode, and replaying each one is 20 seconds of
		// black frames apiece. A software renderer shows nothing either way.
		if (!shown && !soft && !software) {
			soft = 1;
			shown = play(mpv, rc, fbo, argv[i], "no", 1);
			if (shown)
				printf("%s: this host could not hardware decode it; software decoding renders\n",
				       argv[i]);
		}
		if (!shown && software)
			fail(argv[i], "mpv never decoded a frame to render");
		else if (!shown)
			fail(argv[i], "no frame reached the framebuffer, in hardware or software");
	}

	mpv_render_context_free(rc);
	mpv_terminate_destroy(mpv);
	if (failed)
		return 1;
	printf("ok\n");
	return 0;
}
