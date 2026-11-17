//go:build ios
// Minimal bootstrap: delegate comes from Go archive (WailsAppDelegate)
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#include <stdio.h>

// internal/iosshell (#127): the webview comes back after iOS kills WebKit's
// content process. Must run before the webview gets its delegate.
extern void peliCrashRecovery(void);

// Wails lays its webview out INSIDE the safe area (WailsViewController's
// viewDidLayoutSubviews), so the bands under the status bar, the Dynamic
// Island and the home indicator show the window colour: the player's scrim
// stopped short of the video under it, and pages couldn't bleed to the edge.
// Run Wails' layout, then give the webview the whole view. The page pads
// itself with env(safe-area-inset-*) (index.html has viewport-fit=cover, and
// Wails turns the scroll view's automatic insets off). Wails' native tab bar,
// which Peli doesn't use, keeps its own layout.
static void peliFullScreenWebview(void) {
    Class cls = NSClassFromString(@"WailsViewController");
    SEL sel = @selector(viewDidLayoutSubviews);
    Method method = cls ? class_getInstanceMethod(cls, sel) : NULL;
    if (!method) return;
    void (*wails)(id, SEL) = (void (*)(id, SEL))method_getImplementation(method);
    IMP full = imp_implementationWithBlock(^(UIViewController *vc) {
        wails(vc, sel);
        UITabBar *tabs = nil;
        @try { tabs = [vc valueForKey:@"tabBar"]; } @catch (NSException *e) {}
        if (tabs && !tabs.isHidden) return;
        UIView *web = nil;
        @try { web = [vc valueForKey:@"webView"]; } @catch (NSException *e) {}
        web.frame = vc.view.bounds;
    });
    method_setImplementation(method, full);
}

// Xcode 27's SDK refuses to launch an app that doesn't adopt the UIScene life
// cycle ("UIScene life cycle is required for apps built with this SDK").
// Wails' app delegate (WailsAppDelegate, from the Go archive) still creates
// the window and starts the Go runtime in didFinishLaunching, so this scene
// delegate only attaches that window to the scene, and passes the life-cycle
// callbacks UIKit no longer sends the app delegate once scenes are adopted
// (Peli's iOS main listens for DidBecomeActive and DidEnterBackground).
@interface PeliSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (strong, nonatomic) UIWindow *window;
@end

@implementation PeliSceneDelegate
- (id<UIApplicationDelegate>)app {
    return UIApplication.sharedApplication.delegate;
}

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    if (![scene isKindOfClass:UIWindowScene.class]) return;
    // The app delegate made its window before there was a scene, and a window
    // with no scene never shows. Make one for the scene, carry over what the
    // delegate (and Wails, if it got there first) put in the old one, and
    // hand it to the delegate so the webview goes in this one.
    UIWindow *old = [(id)self.app valueForKey:@"window"];
    UIWindow *window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    window.backgroundColor = old.backgroundColor;
    window.rootViewController = old.rootViewController;
    [(id)self.app setValue:window forKey:@"window"];
    self.window = window;
    [window makeKeyAndVisible];
}

- (void)sceneDidBecomeActive:(UIScene *)scene {
    if ([self.app respondsToSelector:@selector(applicationDidBecomeActive:)])
        [self.app applicationDidBecomeActive:UIApplication.sharedApplication];
}

- (void)sceneWillResignActive:(UIScene *)scene {
    if ([self.app respondsToSelector:@selector(applicationWillResignActive:)])
        [self.app applicationWillResignActive:UIApplication.sharedApplication];
}

- (void)sceneWillEnterForeground:(UIScene *)scene {
    if ([self.app respondsToSelector:@selector(applicationWillEnterForeground:)])
        [self.app applicationWillEnterForeground:UIApplication.sharedApplication];
}

- (void)sceneDidEnterBackground:(UIScene *)scene {
    if ([self.app respondsToSelector:@selector(applicationDidEnterBackground:)])
        [self.app applicationDidEnterBackground:UIApplication.sharedApplication];
}
@end

int main(int argc, char * argv[]) {
    @autoreleasepool {
        // Disable buffering so stdout/stderr from Go log.Printf flush immediately
        setvbuf(stdout, NULL, _IONBF, 0);
        setvbuf(stderr, NULL, _IONBF, 0);

        // Only swaps a method on a class already loaded: nothing starts.
        peliFullScreenWebview();
        peliCrashRecovery();

        // Call UIApplicationMain IMMEDIATELY and start NOTHING else here. Do not
        // start the Go runtime yet: starting it concurrently with UIApplicationMain
        // intermittently corrupts the FrontBoard launch handshake on a physical
        // device, so the app delegate's didFinishLaunchingWithOptions never fires
        // (blank cold launch / 0x8BADF00D). Instead, the WailsAppDelegate (provided
        // by the Go archive) starts the Go runtime itself from
        // didFinishLaunchingWithOptions — i.e. only AFTER UIKit has delivered the
        // launch — so the runtime never races the launch handshake.
        return UIApplicationMain(argc, argv, nil, @"WailsAppDelegate");
    }
}
