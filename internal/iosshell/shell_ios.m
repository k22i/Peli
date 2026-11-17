//go:build ios

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <mach/mach.h>
#include <os/proc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>

#include "shell_ios.h"

// What the webview shows after three content-process deaths within two
// minutes: plain HTML with no Peli in it, so it can't be what runs out of
// memory. Reload goes to Home.
static NSString *const peliErrorPage =
    @"<!doctype html><html><head><meta charset=utf-8>"
     "<meta name=viewport content='width=device-width,initial-scale=1,viewport-fit=cover'>"
     "<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;"
     "background:#0e0d0c;color:#f5f2ec;font:16px -apple-system,system-ui,sans-serif;text-align:center}"
     "main{max-width:22rem;padding:2rem}h1{font-size:1.375rem;margin:0 0 .5rem}p{color:#a8a29a;margin:0 0 1.5rem}"
     "a{display:inline-block;padding:.8rem 1.75rem;border-radius:999px;background:#f5b445;color:#0e0d0c;"
     "text-decoration:none;font-weight:600}</style></head><body><main>"
     "<h1>Peli stopped responding</h1>"
     "<p>The page closed several times in a row, usually because the phone ran low on memory.</p>"
     "<a href='/?peli-recovered=manual#/'>Reload</a></main></body></html>";

// Adds sel to cls, or, if it is there already (a later Wails), runs the
// existing one first and then block.
static void peliAddOrChain(Class cls, SEL sel, const char *types, void (^after)(id self, NSArray *args), int nargs) {
    Method existing = class_getInstanceMethod(cls, sel);
    if (nargs == 1) {
        void (*prev)(id, SEL, id) = existing ? (void (*)(id, SEL, id))method_getImplementation(existing) : NULL;
        IMP imp = imp_implementationWithBlock(^(id self, id a) {
            if (prev) prev(self, sel, a);
            after(self, @[ a ?: [NSNull null] ]);
        });
        if (existing) method_setImplementation(existing, imp);
        else class_addMethod(cls, sel, imp, types);
    } else {
        void (*prev)(id, SEL, id, id, id) = existing ? (void (*)(id, SEL, id, id, id))method_getImplementation(existing) : NULL;
        IMP imp = imp_implementationWithBlock(^(id self, id a, id b, id c) {
            if (prev) prev(self, sel, a, b, c);
            after(self, @[ a ?: [NSNull null], b ?: [NSNull null], c ?: [NSNull null] ]);
        });
        if (existing) method_setImplementation(existing, imp);
        else class_addMethod(cls, sel, imp, types);
    }
}

static void peliLogFailure(const char *kind, WKWebView *web, NSError *error) {
    NSString *url = error.userInfo[NSURLErrorFailingURLStringErrorKey] ?: web.URL.absoluteString ?: @"";
    // Only Peli's own pages: an addon's page or a link isn't ours to log.
    if (![url hasPrefix:@"wails:"] && url.length > 0) return;
    peliNavigationFailed((char *)kind, (char *)url.UTF8String, (char *)(error.localizedDescription ?: @"").UTF8String);
}

void peliCrashRecovery(void) {
    Class cls = NSClassFromString(@"WailsViewController");
    if (!cls) return;

    // iOS killed WebKit's content process (memory, a WebKit crash): the
    // webview goes blank while Go lives on. Go logs it, applies the loop
    // guard and says what to load. A reload of the same route is a load of
    // its address with ?peli-recovered=reload (not [webView reload]), so the
    // page knows it came back and restores the route it saved.
    peliAddOrChain(cls, @selector(webViewWebContentProcessDidTerminate:), "v@:@", ^(id self, NSArray *args) {
        WKWebView *web = [args[0] isKindOfClass:WKWebView.class] ? args[0] : nil;
        if (!web) return;
        int action = 0;
        char *target = peliWebContentTerminated((char *)(web.URL.absoluteString ?: @"").UTF8String, &action);
        if (action == 2 || !target) {
            [web loadHTMLString:peliErrorPage baseURL:[NSURL URLWithString:@"wails://localhost/"]];
        } else {
            NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:target]];
            if (url) [web loadRequest:[NSURLRequest requestWithURL:url]];
            else [web reload];
        }
        free(target);
    }, 1);

    // Failed loads of Peli's own pages: logged only.
    peliAddOrChain(cls, @selector(webView:didFailProvisionalNavigation:withError:), "v@:@@@", ^(id self, NSArray *args) {
        WKWebView *web = [args[0] isKindOfClass:WKWebView.class] ? args[0] : nil;
        NSError *error = [args[2] isKindOfClass:NSError.class] ? args[2] : nil;
        peliLogFailure("provisional", web, error);
    }, 3);
    peliAddOrChain(cls, @selector(webView:didFailNavigation:withError:), "v@:@@@", ^(id self, NSArray *args) {
        WKWebView *web = [args[0] isKindOfClass:WKWebView.class] ? args[0] : nil;
        NSError *error = [args[2] isKindOfClass:NSError.class] ? args[2] : nil;
        peliLogFailure("navigation", web, error);
    }, 3);

    [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidReceiveMemoryWarningNotification
                                                    object:nil
                                                     queue:nil
                                                usingBlock:^(NSNotification *note) { peliMemoryWarning(); }];
}

static UIViewController *peliTopController(void) {
    id delegate = UIApplication.sharedApplication.delegate;
    UIWindow *window = nil;
    @try { window = [delegate valueForKey:@"window"]; } @catch (NSException *e) {}
    UIViewController *vc = window.rootViewController;
    while (vc.presentedViewController) vc = vc.presentedViewController;
    return vc;
}

int peli_shell_share(const char **paths, int n) {
    NSMutableArray *items = [NSMutableArray arrayWithCapacity:n];
    for (int i = 0; i < n; i++) {
        [items addObject:[NSURL fileURLWithPath:[NSString stringWithUTF8String:paths[i]]]];
    }
    __block int rc = 0;
    void (^present)(void) = ^{
        UIViewController *top = peliTopController();
        if (!top) { rc = -1; return; }
        UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:items applicationActivities:nil];
        // iPad shows it as a popover, which needs somewhere to point.
        UIPopoverPresentationController *pop = sheet.popoverPresentationController;
        if (pop) {
            pop.sourceView = top.view;
            CGRect b = top.view.bounds;
            pop.sourceRect = CGRectMake(CGRectGetMidX(b), CGRectGetMidY(b), 1, 1);
            pop.permittedArrowDirections = 0;
        }
        [top presentViewController:sheet animated:YES completion:nil];
    };
    if (NSThread.isMainThread) present();
    else dispatch_sync(dispatch_get_main_queue(), present);
    return rc;
}

void peli_shell_memory(uint64_t *available, uint64_t *footprint) {
    *available = (uint64_t)os_proc_available_memory();
    task_vm_info_data_t info;
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    *footprint = task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) == KERN_SUCCESS
        ? (uint64_t)info.phys_footprint : 0;
}

void peli_shell_device(char *buf, int n) {
    struct utsname u;
    uname(&u);
    NSOperatingSystemVersion v = NSProcessInfo.processInfo.operatingSystemVersion;
    snprintf(buf, n, "iOS %ld.%ld.%ld (%s)", (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion, u.machine);
}
