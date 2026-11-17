//go:build ios

#import <UIKit/UIKit.h>
#include "quickactions_ios.h"

static NSString *const kTitleType = @"net.k22i.peli.title";

void peli_quickactions_set(const char *json) {
    NSData *data = json ? [NSData dataWithBytes:json length:strlen(json)] : nil;
    NSArray *items = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![items isKindOfClass:NSArray.class]) return;
    NSMutableArray<UIApplicationShortcutItem *> *shortcuts = [NSMutableArray array];
    UIApplicationShortcutIcon *icon = [UIApplicationShortcutIcon iconWithSystemImageName:@"play.circle"];
    for (NSDictionary *item in items) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *title = item[@"title"];
        if (![title isKindOfClass:NSString.class] || title.length == 0) continue;
        NSString *subtitle = item[@"subtitle"];
        if (![subtitle isKindOfClass:NSString.class] || subtitle.length == 0) subtitle = nil;
        // What comes back through peliQuickAction: type, id and episode.
        NSMutableDictionary *info = [NSMutableDictionary dictionary];
        for (NSString *key in @[@"type", @"id", @"videoId", @"title"]) {
            NSString *value = item[key];
            if ([value isKindOfClass:NSString.class] && value.length) info[key] = value;
        }
        [shortcuts addObject:[[UIApplicationShortcutItem alloc] initWithType:kTitleType
                                                              localizedTitle:title
                                                           localizedSubtitle:subtitle
                                                                        icon:icon
                                                                    userInfo:info]];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        UIApplication.sharedApplication.shortcutItems = shortcuts;
    });
}

// Called by the scene delegate (build/ios/main.m) for a tap on a running app
// (windowScene:performActionForShortcutItem:) and for the one that launched
// it (connectionOptions.shortcutItem). Go keeps it until the page asks.
BOOL peliHandleShortcutItem(UIApplicationShortcutItem *item) {
    if (!item) return NO;
    NSString *info = @"{}";
    if (item.userInfo) {
        NSData *data = [NSJSONSerialization dataWithJSONObject:item.userInfo options:0 error:nil];
        if (data) info = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    }
    peliQuickAction((char *)item.type.UTF8String, (char *)info.UTF8String);
    return YES;
}
