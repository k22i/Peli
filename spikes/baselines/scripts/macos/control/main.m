// Control for the macOS numbers: a plain Cocoa app with one WKWebView and no
// Wails, Go or React, reporting the same marks in the same format as main.go,
// so bench/ can measure the platform's floor. Throwaway; see ../../../README.md.
//
//   clang -fobjc-arc -O2 -framework Cocoa -framework WebKit main.m -o control
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <sys/time.h>

static long long nowUs(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000 + tv.tv_usec;
}

static long long tMain;
static NSMutableDictionary *goMarks;

static void mark(NSString *name) {
    if (!goMarks[name]) goMarks[name] = @(nowUs());
}

// The same visible structure as the React shell, as static HTML.
static NSString *const kPage = @"<!doctype html><html><head><meta charset=utf-8><style>"
    ":root{color-scheme:dark;font-family:system-ui;background:#0d0f14;color:#e8eaf0}html,body{margin:0;height:100%}"
    ".shell{display:flex;height:100%}nav{width:200px;padding:20px 12px;background:#13161d;display:flex;flex-direction:column;gap:4px}"
    "nav a{color:#aab0bf;padding:8px;text-decoration:none}main{flex:1}header{padding:16px 24px}"
    "input{width:320px;padding:8px 12px;border-radius:6px;border:1px solid #2a3040;background:#13161d;color:inherit}"
    "</style></head><body><div class=shell><nav><b>Cove</b><a>Home</a><a>Movies</a><a>Shows</a><a>Anime</a><a>Library</a><a>Settings</a></nav>"
    "<main><header><input placeholder='Search movies and shows'></header><p>Nothing here yet.</p></main></div><script>"
    "const now=()=>performance.timeOrigin+performance.now();const m={timeOrigin:performance.timeOrigin,scriptStart:now()};"
    "m.mounted=now();requestAnimationFrame(()=>{m.raf=now();setTimeout(()=>{m.painted=now();m.visibility=document.visibilityState;"
    "m.focused=document.hasFocus();const n=performance.getEntriesByType('navigation')[0];if(n){m.responseEnd=performance.timeOrigin+n.responseEnd;"
    "m.domContentLoaded=performance.timeOrigin+n.domContentLoadedEventEnd}setTimeout(()=>{for(const e of performance.getEntriesByType('paint'))"
    "m[e.name==='first-contentful-paint'?'fcp':'firstPaint']=performance.timeOrigin+e.startTime;"
    "webkit.messageHandlers.report.postMessage(m)},500)},0)});</script></body></html>";

@interface Delegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler>
@property(strong) NSWindow *window;
@end

@implementation Delegate
- (void)applicationDidFinishLaunching:(NSNotification *)n {
    mark(@"appStarted");
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 800)
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                        NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"Cove control";
    WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
    [cfg.userContentController addScriptMessageHandler:self name:@"report"];
    WKWebView *web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:cfg];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self.window.contentView addSubview:web];
    [web loadHTMLString:kPage baseURL:nil];
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    mark(@"windowShow");
    [NSApp activateIgnoringOtherApps:YES];

    NSString *quit = NSProcessInfo.processInfo.environment[@"BASELINE_QUIT_FILE"];
    if (quit) {
        [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *t) {
            if ([NSFileManager.defaultManager fileExistsAtPath:quit]) [NSApp terminate:nil];
        }];
    }
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app {
    return YES;
}

- (void)userContentController:(WKUserContentController *)uc didReceiveScriptMessage:(WKScriptMessage *)msg {
    mark(@"reportReceived");
    NSDictionary *out = @{@"pid" : @(getpid()), @"goos" : @"darwin", @"control" : @YES, @"go" : goMarks, @"page" : msg.body};
    NSString *path = NSProcessInfo.processInfo.environment[@"BASELINE_REPORT"];
    NSData *data = [NSJSONSerialization dataWithJSONObject:out options:NSJSONWritingPrettyPrinted error:nil];
    if (!path) {
        NSLog(@"%@", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
        return;
    }
    NSString *tmp = [path stringByAppendingString:@".tmp"];
    [data writeToFile:tmp atomically:NO];
    rename(tmp.UTF8String, path.UTF8String);
}
@end

int main(int argc, const char *argv[]) {
    tMain = nowUs();
    @autoreleasepool {
        goMarks = [NSMutableDictionary dictionaryWithDictionary:@{@"goInit" : @(tMain), @"main" : @(tMain)}];
        NSApplication *app = [NSApplication sharedApplication];
        app.activationPolicy = NSApplicationActivationPolicyRegular;
        Delegate *d = [Delegate new];
        app.delegate = d;
        [app run];
    }
    return 0;
}
