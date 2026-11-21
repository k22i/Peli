//go:build ios

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <Network/Network.h>
#include "platform_ios.h"

int peli_dl_free_space(const char *dir, long long *out) {
	@autoreleasepool {
		NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:dir] isDirectory:YES];
		NSError *err = nil;
		NSDictionary *v = [url resourceValuesForKeys:@[NSURLVolumeAvailableCapacityForImportantUsageKey] error:&err];
		NSNumber *n = v[NSURLVolumeAvailableCapacityForImportantUsageKey];
		if (n != nil && n.longLongValue > 0) {
			*out = n.longLongValue;
			return 0;
		}
		NSDictionary *a = [NSFileManager.defaultManager attributesOfFileSystemForPath:url.path error:&err];
		NSNumber *f = a[NSFileSystemFreeSize];
		if (f == nil) return -1;
		*out = f.longLongValue;
		return 0;
	}
}

int peli_dl_exclude_backup(const char *path) {
	@autoreleasepool {
		NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path] isDirectory:YES];
		NSError *err = nil;
		return [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&err] ? 0 : -1;
	}
}

static nw_path_monitor_t g_monitor;

void peli_dl_network_start(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		g_monitor = nw_path_monitor_create();
		nw_path_monitor_set_queue(g_monitor, dispatch_queue_create("peli.downloads.network", DISPATCH_QUEUE_SERIAL));
		nw_path_monitor_set_update_handler(g_monitor, ^(nw_path_t path) {
			int online = nw_path_get_status(path) == nw_path_status_satisfied;
			peliDownloadsNetwork(online, nw_path_is_expensive(path) ? 1 : 0);
		});
		nw_path_monitor_start(g_monitor);
	});
}

// UIKit's notifications, as internal/iosplayer does: Wails' application events
// are not seen under Peli's scene delegate (ADR-0059).
void peli_dl_lifecycle_observe(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
		[nc addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:nil
		            usingBlock:^(NSNotification *n) { peliDownloadsLifecycle(PELI_DL_BACKGROUND); }];
		[nc addObserverForName:UIApplicationDidBecomeActiveNotification object:nil queue:nil
		            usingBlock:^(NSNotification *n) { peliDownloadsLifecycle(PELI_DL_ACTIVE); }];
	});
}

// Main thread only.
static NSMutableDictionary<NSNumber *, NSTimer *> *g_timers;

static void end_task(unsigned long id) {
	NSNumber *key = @(id);
	NSTimer *t = g_timers[key];
	if (t == nil) return; // already ended
	[t invalidate];
	[g_timers removeObjectForKey:key];
	[UIApplication.sharedApplication endBackgroundTask:(UIBackgroundTaskIdentifier)id];
}

unsigned long peli_dl_background_begin(void) {
	__block unsigned long id = 0;
	void (^work)(void) = ^{
		if (g_timers == nil) g_timers = [NSMutableDictionary dictionary];
		__block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
		task = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Peli downloads" expirationHandler:^{
			// Go flushes, then the task ends.
			peliDownloadsExpiring((unsigned long)task, 0);
			end_task((unsigned long)task);
		}];
		if (task == UIBackgroundTaskInvalid) return;
		id = (unsigned long)task;
		unsigned long key = id;
		NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *t) {
			NSTimeInterval left = UIApplication.sharedApplication.backgroundTimeRemaining;
			// Foreground reports a huge value, so only the real countdown fires.
			if (left < 5.0) {
				[t invalidate]; // once per task; the task itself stays until end
				peliDownloadsExpiring(key, 1);
			}
		}];
		g_timers[@(id)] = timer;
	};
	if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	return id;
}

void peli_dl_background_end(unsigned long id) {
	if (id == 0) return;
	dispatch_async(dispatch_get_main_queue(), ^{ end_task(id); });
}
