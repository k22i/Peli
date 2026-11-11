// How long the player's renderer takes for one frame with given options:
// the cost of a scaler, debanding or a shader on this Mac's GPU, through the
// OpenGL render API the macOS host uses. It plays the file in a loop and
// times the render of each new frame (render + glFinish): a redraw of the
// same frame only copies mpv's cached output, so it would time nothing.
// Decoding runs alongside on the media engine and isn't in the number.
//
//   cc -O2 -o bench smoke/bench_darwin.c $(pkg-config --cflags --libs mpv) -framework OpenGL
//   ./bench <file> <W>x<H> [option=value ...]
//
// It prints the median and the 90th percentile in ms, and whether the frame
// the options were asked for came out (an option or shader the build
// refuses is a FAIL).
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <mpv/client.h>
#include <mpv/render_gl.h>

enum { RUNS = 150, WARM = 15 };

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

static double now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static int cmp(const void *a, const void *b) {
	double x = *(const double *)a, y = *(const double *)b;
	return x < y ? -1 : x > y;
}

int main(int argc, char **argv) {
	int w, h;
	if (argc < 3 || sscanf(argv[2], "%dx%d", &w, &h) != 2) {
		fprintf(stderr, "usage: bench <file> <W>x<H> [option=value ...]\n");
		return 2;
	}
	CGLPixelFormatAttribute attrs[] = {
		kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
		kCGLPFAColorSize, 24, kCGLPFAAccelerated, 0,
	};
	CGLPixelFormatObj pix;
	GLint npix;
	CGLContextObj gl;
	if (CGLChoosePixelFormat(attrs, &pix, &npix) || !pix || CGLCreateContext(pix, NULL, &gl))
		return fprintf(stderr, "FAIL: no OpenGL context\n"), 1;
	CGLSetCurrentContext(gl);

	GLuint fbo, tex;
	glGenTextures(1, &tex);
	glBindTexture(GL_TEXTURE_2D, tex);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
	glGenFramebuffers(1, &fbo);
	glBindFramebuffer(GL_FRAMEBUFFER, fbo);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);

	mpv_handle *mpv = mpv_create();
	check(mpv_set_option_string(mpv, "vo", "libmpv"), "vo");
	check(mpv_set_option_string(mpv, "ao", "null"), "ao");
	check(mpv_set_option_string(mpv, "hwdec", "videotoolbox,auto-safe"), "hwdec");
	check(mpv_set_option_string(mpv, "loop-file", "inf"), "loop-file");
	// As many frames as the renderer takes: no waiting for their time.
	check(mpv_set_option_string(mpv, "video-sync", "desync"), "video-sync");
	check(mpv_set_option_string(mpv, "untimed", "yes"), "untimed");
	for (int i = 3; i < argc; i++) {
		char *eq = strchr(argv[i], '=');
		if (!eq)
			return fprintf(stderr, "FAIL: %s is not option=value\n", argv[i]), 2;
		*eq = 0;
		check(mpv_set_option_string(mpv, argv[i], eq + 1), argv[i]);
	}
	check(mpv_initialize(mpv), "mpv_initialize");
	check(mpv_request_log_messages(mpv, "error"), "log");

	mpv_render_context *rc;
	mpv_opengl_init_params init = {.get_proc_address = proc_address};
	mpv_render_param cparams[] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &init},
		{0},
	};
	check(mpv_render_context_create(&rc, mpv, cparams), "mpv_render_context_create");
	const char *cmd[] = {"loadfile", argv[1], NULL};
	check(mpv_command(mpv, cmd), "loadfile");

	int flip = 1, block = 0, errors = 0;
	mpv_opengl_fbo target = {.fbo = (int)fbo, .w = w, .h = h};
	mpv_render_param params[] = {
		{MPV_RENDER_PARAM_OPENGL_FBO, &target},
		{MPV_RENDER_PARAM_FLIP_Y, &flip},
		{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block},
		{0},
	};
	double ms[RUNS];
	int n = 0, seen = 0;
	for (int i = 0; i < 20000 && n < RUNS; i++) {
		mpv_event *ev = mpv_wait_event(mpv, 0.001);
		if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
			mpv_event_log_message *msg = ev->data;
			fprintf(stderr, "[%s] %s: %s", msg->level, msg->prefix, msg->text);
			errors++;
		}
		if (ev->event_id == MPV_EVENT_END_FILE)
			return fprintf(stderr, "FAIL: the file ended\n"), 1;
		if (!(mpv_render_context_update(rc) & MPV_RENDER_UPDATE_FRAME))
			continue;
		double t = now_ms();
		check(mpv_render_context_render(rc, params), "render");
		glFinish();
		// The first frames compile the shaders.
		if (seen++ >= WARM)
			ms[n++] = now_ms() - t;
	}
	if (n < RUNS)
		return fprintf(stderr, "FAIL: only %d frames\n", n), 1;
	qsort(ms, RUNS, sizeof ms[0], cmp);
	char *hwdec = mpv_get_property_string(mpv, "hwdec-current");
	char *params_w = mpv_get_property_string(mpv, "video-params/w");
	char *params_h = mpv_get_property_string(mpv, "video-params/h");
	printf("%s %sx%s → %dx%d, hwdec %s: median %.2f ms, p90 %.2f ms%s\n", argv[1],
	       params_w ? params_w : "?", params_h ? params_h : "?", w, h, hwdec && *hwdec ? hwdec : "no",
	       ms[RUNS / 2], ms[RUNS * 9 / 10], errors ? " (errors logged)" : "");
	mpv_free(hwdec);
	mpv_free(params_w);
	mpv_free(params_h);
	mpv_render_context_free(rc);
	mpv_terminate_destroy(mpv);
	return errors ? 1 : 0;
}
