//go:build ios

// Which way up the phone is held, from the motion sensor, for the player's
// rotation (the main package's rotation_ios.go). It reads gravity, not the
// interface orientation iOS reports, so it works with Rotation Lock on, as
// YouTube's player does; peli_turn then asks the scene for exactly that side.

#import <UIKit/UIKit.h>
#import <CoreMotion/CoreMotion.h>
#include <math.h>
#include <stdio.h>
#include "host_ios.h"

static CMMotionManager *g_motion;
static NSOperationQueue *g_motionQueue;

// sideOf is the side gravity says, or -1 when the phone lies flat, stands on
// its head or is in between (keep what there is). The margins keep a phone
// held at 45 degrees from flipping back and forth.
static int sideOf(CMAcceleration g) {
	double ax = fabs(g.x), ay = fabs(g.y);
	// Top of the phone to the left: gravity along -x, the home indicator on
	// the right, which is the interface's landscape-right.
	if (g.x <= -0.6 && ax > ay + 0.2) return PELI_SIDE_LANDSCAPE_RIGHT;
	if (g.x >= 0.6 && ax > ay + 0.2) return PELI_SIDE_LANDSCAPE_LEFT;
	if (g.y <= -0.6 && ay > ax + 0.2) return PELI_SIDE_PORTRAIT;
	return -1;
}

void peli_motion_start(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (!g_motion) {
			g_motion = [CMMotionManager new];
			g_motionQueue = [NSOperationQueue new];
			g_motionQueue.maxConcurrentOperationCount = 1;
		}
		if (!g_motion.deviceMotionAvailable) {
			fprintf(stderr, "iosplayer: rotation: no motion sensor\n");
			return;
		}
		if (g_motion.deviceMotionActive) return;
		// A side counts once it held for three readings (0.3 s) and differs
		// from the last one sent; each start sends the first one it sees.
		__block int candidate = -1, count = 0, sent = -1;
		g_motion.deviceMotionUpdateInterval = 0.1;
		[g_motion startDeviceMotionUpdatesToQueue:g_motionQueue withHandler:^(CMDeviceMotion *m, NSError *e) {
			if (!m) return;
			int side = sideOf(m.gravity);
			if (side < 0) {
				count = 0;
				return;
			}
			if (side != candidate) {
				candidate = side;
				count = 0;
			}
			if (++count < 3 || side == sent) return;
			sent = side;
			peliMotionSide(side);
		}];
	});
}

void peli_motion_stop(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		[g_motion stopDeviceMotionUpdates];
	});
}

void peli_turn(int side) {
	dispatch_async(dispatch_get_main_queue(), ^{
		UIInterfaceOrientationMask mask = UIInterfaceOrientationMaskPortrait;
		if (side == PELI_SIDE_LANDSCAPE_LEFT) mask = UIInterfaceOrientationMaskLandscapeLeft;
		if (side == PELI_SIDE_LANDSCAPE_RIGHT) mask = UIInterfaceOrientationMaskLandscapeRight;
		for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
			if (![scene isKindOfClass:UIWindowScene.class]) continue;
			UIWindowScene *ws = (UIWindowScene *)scene;
			for (UIWindow *w in ws.windows) [w.rootViewController setNeedsUpdateOfSupportedInterfaceOrientations];
			UIWindowSceneGeometryPreferencesIOS *prefs =
				[[UIWindowSceneGeometryPreferencesIOS alloc] initWithInterfaceOrientations:mask];
			[ws requestGeometryUpdateWithPreferences:prefs errorHandler:^(NSError *err) {
				fprintf(stderr, "iosplayer: rotation: turn %d refused: %s\n", side, err.localizedDescription.UTF8String);
			}];
		}
	});
}
