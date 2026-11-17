//go:build ios

// The QR scanner for device pairing (#133, ADR-0061): AVFoundation's QR
// metadata reader in a full-screen controller with a Close button.
// VisionKit's DataScannerViewController would do the same, but it is
// Swift-only and the app has no Swift.

#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

#include "scanner_ios.h"

@interface PeliScanner : UIViewController <AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic, copy) NSString *prefix;
@property(nonatomic, strong) AVCaptureSession *session;
@property(nonatomic, strong) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic) BOOL finished;
@end

static PeliScanner *g_scanner;

// finish reports once and dismisses. Main thread.
static void finish(PeliScanner *s, NSString *text, int status, BOOL report) {
	if (!s || s.finished) return;
	s.finished = YES;
	AVCaptureSession *session = s.session;
	dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
		[session stopRunning];
	});
	if (g_scanner == s) g_scanner = nil;
	[s.presentingViewController dismissViewControllerAnimated:YES completion:nil];
	if (report) peliShellScanned(text ? (char *)text.UTF8String : NULL, status);
}

@implementation PeliScanner

- (void)viewDidLoad {
	[super viewDidLoad];
	self.view.backgroundColor = UIColor.blackColor;

	AVCaptureDevice *camera = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
	NSError *error = nil;
	AVCaptureDeviceInput *input = camera ? [AVCaptureDeviceInput deviceInputWithDevice:camera error:&error] : nil;
	AVCaptureSession *session = [AVCaptureSession new];
	AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
	if (!input || ![session canAddInput:input] || ![session canAddOutput:output]) {
		dispatch_async(dispatch_get_main_queue(), ^{ finish(self, nil, 3, YES); });
		return;
	}
	[session addInput:input];
	[session addOutput:output];
	[output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
	if ([output.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeQRCode]) {
		output.metadataObjectTypes = @[ AVMetadataObjectTypeQRCode ];
	}
	self.session = session;

	self.preview = [AVCaptureVideoPreviewLayer layerWithSession:session];
	self.preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
	[self.view.layer addSublayer:self.preview];

	// A square guide in the middle, and what to do.
	UIView *guide = [UIView new];
	guide.translatesAutoresizingMaskIntoConstraints = NO;
	guide.layer.borderColor = [UIColor colorWithWhite:1 alpha:0.9].CGColor;
	guide.layer.borderWidth = 3;
	guide.layer.cornerRadius = 24;
	guide.userInteractionEnabled = NO;
	[self.view addSubview:guide];

	UILabel *hint = [UILabel new];
	hint.translatesAutoresizingMaskIntoConstraints = NO;
	hint.text = @"Point the camera at the code on your other device";
	hint.textColor = UIColor.whiteColor;
	hint.font = [UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];
	hint.adjustsFontForContentSizeCategory = YES;
	hint.numberOfLines = 0;
	hint.textAlignment = NSTextAlignmentCenter;
	[self.view addSubview:hint];

	UIButtonConfiguration *config = [UIButtonConfiguration filledButtonConfiguration];
	config.title = @"Close";
	config.baseBackgroundColor = [UIColor colorWithWhite:0.15 alpha:0.8];
	config.baseForegroundColor = UIColor.whiteColor;
	config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
	config.contentInsets = NSDirectionalEdgeInsetsMake(12, 24, 12, 24);
	UIButton *close = [UIButton buttonWithConfiguration:config primaryAction:nil];
	close.translatesAutoresizingMaskIntoConstraints = NO;
	close.accessibilityLabel = @"Close scanner";
	[close addTarget:self action:@selector(close) forControlEvents:UIControlEventTouchUpInside];
	[self.view addSubview:close];

	UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
	[NSLayoutConstraint activateConstraints:@[
		[guide.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
		[guide.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
		[guide.widthAnchor constraintEqualToConstant:240],
		[guide.heightAnchor constraintEqualToConstant:240],
		[hint.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:24],
		[hint.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-24],
		[hint.topAnchor constraintEqualToAnchor:safe.topAnchor constant:32],
		[close.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
		[close.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-24],
		[close.heightAnchor constraintGreaterThanOrEqualToConstant:44],
	]];
}

- (void)viewDidLayoutSubviews {
	[super viewDidLayoutSubviews];
	self.preview.frame = self.view.bounds;
	AVCaptureConnection *connection = self.preview.connection;
	UIWindowScene *scene = self.view.window.windowScene;
	if (connection && scene) {
		CGFloat angle = 90;
		switch (scene.effectiveGeometry.interfaceOrientation) {
		case UIInterfaceOrientationLandscapeLeft: angle = 180; break;
		case UIInterfaceOrientationLandscapeRight: angle = 0; break;
		case UIInterfaceOrientationPortraitUpsideDown: angle = 270; break;
		default: break;
		}
		if ([connection isVideoRotationAngleSupported:angle]) connection.videoRotationAngle = angle;
	}
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	AVCaptureSession *session = self.session;
	if (!session) return;
	dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
		[session startRunning];
	});
}

- (void)close {
	finish(self, nil, 1, YES);
}

- (void)captureOutput:(AVCaptureOutput *)output
	didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objects
	       fromConnection:(AVCaptureConnection *)connection {
	for (AVMetadataObject *object in objects) {
		if (![object isKindOfClass:AVMetadataMachineReadableCodeObject.class]) continue;
		NSString *text = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
		if (!text.length) continue;
		if (self.prefix.length && ![text hasPrefix:self.prefix]) continue;
		UINotificationFeedbackGenerator *haptic = [UINotificationFeedbackGenerator new];
		[haptic notificationOccurred:UINotificationFeedbackTypeSuccess];
		finish(self, text, 0, YES);
		return;
	}
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
	return UIInterfaceOrientationMaskAll;
}

@end

int peli_camera_access(void) {
	if (![AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo]) return 3;
	switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]) {
	case AVAuthorizationStatusNotDetermined: return 0;
	case AVAuthorizationStatusAuthorized: return 1;
	default: return 2;
	}
}

static void present(UIViewController *vc, NSString *prefix) {
	if (g_scanner) finish(g_scanner, nil, 1, NO);
	PeliScanner *scanner = [PeliScanner new];
	scanner.prefix = prefix;
	scanner.modalPresentationStyle = UIModalPresentationFullScreen;
	g_scanner = scanner;
	UIViewController *top = vc;
	while (top.presentedViewController) top = top.presentedViewController;
	[top presentViewController:scanner animated:YES completion:nil];
}

void peli_scan_start(void *vcHandle, const char *cprefix) {
	NSString *prefix = cprefix ? [NSString stringWithUTF8String:cprefix] : @"";
	UIViewController *vc = (__bridge UIViewController *)vcHandle;
	dispatch_async(dispatch_get_main_queue(), ^{
		if (!vc || ![vc isKindOfClass:UIViewController.class]) {
			peliShellScanned(NULL, 3);
			return;
		}
		switch (peli_camera_access()) {
		case 1:
			present(vc, prefix);
			return;
		case 0: {
			[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
			                         completionHandler:^(BOOL granted) {
				dispatch_async(dispatch_get_main_queue(), ^{
					if (granted) present(vc, prefix);
					else peliShellScanned(NULL, 2);
				});
			}];
			return;
		}
		case 2:
			peliShellScanned(NULL, 2);
			return;
		default:
			peliShellScanned(NULL, 3);
		}
	});
}

void peli_scan_cancel(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		finish(g_scanner, nil, 1, NO);
	});
}
