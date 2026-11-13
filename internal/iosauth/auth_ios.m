//go:build ios

// A sign-in page that keeps the app active. Opening Safari backgrounds the
// app, and a backgrounded app is suspended within seconds, which takes down
// the loopback page AniList redirects to (ADR-0059). An
// ASWebAuthenticationSession is a sheet over the app, so the app stays in
// the foreground and the page keeps being served.

#import <UIKit/UIKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#include "auth_ios.h"

@interface PeliAuthAnchor : NSObject <ASWebAuthenticationPresentationContextProviding>
@end

@implementation PeliAuthAnchor
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session {
	for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
		if (![scene isKindOfClass:UIWindowScene.class]) continue;
		for (UIWindow *w in ((UIWindowScene *)scene).windows)
			if (w.isKeyWindow) return w;
	}
	for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
		if ([scene isKindOfClass:UIWindowScene.class] && ((UIWindowScene *)scene).windows.firstObject)
			return ((UIWindowScene *)scene).windows.firstObject;
	return nil;
}
@end

static ASWebAuthenticationSession *g_session;
static PeliAuthAnchor *g_anchor;

int peli_auth_open(const char *address, const char *scheme) {
	__block int rc = 0;
	NSString *a = [NSString stringWithUTF8String:address], *sch = [NSString stringWithUTF8String:scheme];
	void (^work)(void) = ^{
		NSURL *u = [NSURL URLWithString:a];
		if (!u || !([u.scheme isEqualToString:@"https"] || [u.scheme isEqualToString:@"http"])) { rc = -1; return; }
		[g_session cancel];
		g_anchor = [PeliAuthAnchor new];
		__block ASWebAuthenticationSession *me = nil;
		me = [[ASWebAuthenticationSession alloc] initWithURL:u callbackURLScheme:sch
			completionHandler:^(NSURL *cb, NSError *err) {
				// Cancel (the user, or peli_auth_close) is the only way out.
				if (g_session == me) { g_session = nil; peliAuthEnded(); }
			}];
		me.presentationContextProvider = g_anchor;
		// Shared with Safari by default: an AniList login already there is
		// reused, at the price of the system's one-tap "wants to use … to Sign
		// In" prompt. $PELI_AUTH_EPHEMERAL=1 (the simulator rig, where nothing
		// can tap the prompt) uses a private session with no prompt.
		const char *eph = getenv("PELI_AUTH_EPHEMERAL");
		me.prefersEphemeralWebBrowserSession = eph && *eph == '1';
		if (![g_anchor presentationAnchorForWebAuthenticationSession:me]) { rc = -2; return; }
		g_session = me;
		if (![me start]) { g_session = nil; rc = -3; }
	};
	if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	return rc;
}

void peli_auth_close(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		ASWebAuthenticationSession *s = g_session;
		g_session = nil; // closing on purpose is not the user cancelling
		[s cancel];
	});
}
