// vinput: a long-lived virtual pointer + keyboard for wlroots compositors,
// driven by commands on stdin. wlrctl and wtype create their device, send the
// event and remove the device within a few milliseconds, before GTK has
// bound wl_pointer / wl_keyboard, so their events never reach the app.
//
//   vinput <layout-width> <layout-height> <<EOF
//   sleep 1000          # give clients time to bind the new devices
//   move 640 360        # absolute, in layout pixels
//   click               # left button
//   key 45              # evdev keycode (45 = KEY_X)
//   EOF
#define _GNU_SOURCE
#include <linux/input-event-codes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *pm;
static struct zwp_virtual_keyboard_manager_v1 *km;

static void global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
	if (!strcmp(iface, wl_seat_interface.name)) seat = wl_registry_bind(r, name, &wl_seat_interface, 1);
	if (!strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name))
		pm = wl_registry_bind(r, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
	if (!strcmp(iface, zwp_virtual_keyboard_manager_v1_interface.name))
		km = wl_registry_bind(r, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
}
static void global_remove(void *d, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener listener = {global, global_remove};

static uint32_t now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int main(int argc, char **argv) {
	uint32_t w = argc > 2 ? atoi(argv[1]) : 1600, h = argc > 2 ? atoi(argv[2]) : 900;
	struct wl_display *dpy = wl_display_connect(NULL);
	if (!dpy) return fprintf(stderr, "vinput: no wayland display\n"), 1;
	struct wl_registry *reg = wl_display_get_registry(dpy);
	wl_registry_add_listener(reg, &listener, NULL);
	wl_display_roundtrip(dpy);
	if (!seat || !pm || !km) return fprintf(stderr, "vinput: compositor lacks virtual input protocols\n"), 1;

	struct zwlr_virtual_pointer_v1 *ptr = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pm, seat);
	struct zwp_virtual_keyboard_v1 *kbd = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(km, seat);
	struct xkb_context *ctx = xkb_context_new(0);
	struct xkb_keymap *map = xkb_keymap_new_from_names(ctx, &(struct xkb_rule_names){0}, 0);
	char *s = xkb_keymap_get_as_string(map, XKB_KEYMAP_FORMAT_TEXT_V1);
	size_t len = strlen(s) + 1;
	int fd = memfd_create("keymap", 0);
	if (write(fd, s, len) != (ssize_t)len) return 1;
	zwp_virtual_keyboard_v1_keymap(kbd, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, len);
	wl_display_roundtrip(dpy);

	char line[128];
	while (fgets(line, sizeof line, stdin)) {
		unsigned a, b;
		if (sscanf(line, "sleep %u", &a) == 1) {
			usleep(a * 1000);
		} else if (sscanf(line, "move %u %u", &a, &b) == 2) {
			zwlr_virtual_pointer_v1_motion_absolute(ptr, now_ms(), a, b, w, h);
			zwlr_virtual_pointer_v1_frame(ptr);
		} else if (!strncmp(line, "click", 5)) {
			zwlr_virtual_pointer_v1_button(ptr, now_ms(), BTN_LEFT, WL_POINTER_BUTTON_STATE_PRESSED);
			zwlr_virtual_pointer_v1_frame(ptr);
			wl_display_flush(dpy);
			usleep(30000);
			zwlr_virtual_pointer_v1_button(ptr, now_ms(), BTN_LEFT, WL_POINTER_BUTTON_STATE_RELEASED);
			zwlr_virtual_pointer_v1_frame(ptr);
		} else if (sscanf(line, "key %u", &a) == 1) {
			zwp_virtual_keyboard_v1_key(kbd, now_ms(), a, WL_KEYBOARD_KEY_STATE_PRESSED);
			wl_display_flush(dpy);
			usleep(30000);
			zwp_virtual_keyboard_v1_key(kbd, now_ms(), a, WL_KEYBOARD_KEY_STATE_RELEASED);
		}
		wl_display_roundtrip(dpy);
	}
	return 0;
}
