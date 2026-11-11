// macOS media controls (#67): Now Playing shows what plays, and the remote
// commands (the media keys, Control Center, AirPods, the Touch Bar) come
// back to Go. On macOS an app must set playbackState itself, and it gets the
// media keys while it is the one Now Playing names. Everything here runs on
// the main queue, in the order Go calls it.
#import <Foundation/Foundation.h>
#import <MediaPlayer/MediaPlayer.h>

// What media.go's mediaCommand names, and how far the skips go.
enum { kPlay = 1, kPause, kToggle, kSeekBy, kSeekTo };
static const double kSkip = 10;

extern void peliMediaCommand(int command, double value);

static MPRemoteCommandHandlerStatus command(int command, double value) {
	peliMediaCommand(command, value);
	return MPRemoteCommandHandlerStatusSuccess;
}

// peli_media_start takes the remote commands. The previous and next
// track keys stay with other apps: a film has no tracks, and the next
// episode is the screen's to offer.
void peli_media_start(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];
		[center.playCommand addTargetWithHandler:^(MPRemoteCommandEvent *e) { return command(kPlay, 0); }];
		[center.pauseCommand addTargetWithHandler:^(MPRemoteCommandEvent *e) { return command(kPause, 0); }];
		[center.togglePlayPauseCommand addTargetWithHandler:^(MPRemoteCommandEvent *e) { return command(kToggle, 0); }];
		center.skipForwardCommand.preferredIntervals = @[ @(kSkip) ];
		[center.skipForwardCommand addTargetWithHandler:^(MPRemoteCommandEvent *e) {
			return command(kSeekBy, ((MPSkipIntervalCommandEvent *)e).interval);
		}];
		center.skipBackwardCommand.preferredIntervals = @[ @(kSkip) ];
		[center.skipBackwardCommand addTargetWithHandler:^(MPRemoteCommandEvent *e) {
			return command(kSeekBy, -((MPSkipIntervalCommandEvent *)e).interval);
		}];
		[center.changePlaybackPositionCommand addTargetWithHandler:^(MPRemoteCommandEvent *e) {
			return command(kSeekTo, ((MPChangePlaybackPositionCommandEvent *)e).positionTime);
		}];
	});
}

void peli_media_show(const char *title, const char *artist, int paused, double position, double duration, double speed) {
	NSMutableDictionary *info = [NSMutableDictionary dictionary];
	info[MPNowPlayingInfoPropertyMediaType] = @(MPNowPlayingInfoMediaTypeVideo);
	info[MPMediaItemPropertyTitle] = [NSString stringWithUTF8String:title];
	if (artist[0]) info[MPMediaItemPropertyArtist] = [NSString stringWithUTF8String:artist];
	// Live streams have no duration; Now Playing then shows no bar.
	if (duration > 0) info[MPMediaItemPropertyPlaybackDuration] = @(duration);
	info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(position);
	// Now Playing moves the position on at this rate by itself.
	info[MPNowPlayingInfoPropertyPlaybackRate] = @(paused ? 0.0 : speed);
	info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = @1.0;
	[info retain];
	dispatch_async(dispatch_get_main_queue(), ^{
		MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
		center.nowPlayingInfo = info;
		center.playbackState = paused ? MPNowPlayingPlaybackStatePaused : MPNowPlayingPlaybackStatePlaying;
		[info release];
	});
}

// peli_media_clear lets go of Now Playing and the commands, so the media
// keys go to other apps again.
void peli_media_clear(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];
		for (MPRemoteCommand *each in @[
			     center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
			     center.skipForwardCommand, center.skipBackwardCommand, center.changePlaybackPositionCommand
		     ]) {
			[each removeTarget:nil];
		}
		MPNowPlayingInfoCenter *info = [MPNowPlayingInfoCenter defaultCenter];
		info.nowPlayingInfo = nil;
		info.playbackState = MPNowPlayingPlaybackStateStopped;
	});
}
