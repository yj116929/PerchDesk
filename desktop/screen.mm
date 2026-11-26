#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#include <node_api.h>
#include <cmath>

struct ScreenFrame {
    CVPixelBufferRef pixels;
    uint32_t width;
    uint32_t height;
    CMTime capturedAt;
};

static napi_value releasePixels(napi_env env, napi_callback_info info) {
    void *data = nullptr;
    size_t count = 0;
    napi_get_cb_info(env, info, &count, nullptr, nullptr, &data);
    auto *frame = static_cast<ScreenFrame *>(data);
    if (frame->pixels) CVPixelBufferRelease(frame->pixels);
    frame->pixels = nullptr;
    return nullptr;
}

static void deleteFrame(napi_env, void *data, void *) {
    auto *frame = static_cast<ScreenFrame *>(data);
    if (frame->pixels) CVPixelBufferRelease(frame->pixels);
    delete frame;
}

static void emitFrame(napi_env env, napi_value callback, void *, void *data) {
    auto *frame = static_cast<ScreenFrame *>(data);
    if (env && callback) {
        napi_value receiver, args[5];
        napi_get_undefined(env, &receiver);
        size_t count = 0;
        if (frame) {
            IOSurfaceRef surface = CVPixelBufferGetIOSurface(frame->pixels);
            napi_create_buffer_copy(env, sizeof(surface), &surface, nullptr, &args[0]);
            napi_create_uint32(env, frame->width, &args[1]);
            napi_create_uint32(env, frame->height, &args[2]);
            napi_create_function(env, "releaseFrame", NAPI_AUTO_LENGTH, releasePixels, frame, &args[3]);
            napi_add_finalizer(env, args[3], frame, deleteFrame, nullptr, nullptr);
            const double ageMs = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), frame->capturedAt)) * 1000;
            if (std::isfinite(ageMs) && ageMs >= 0) napi_create_double(env, ageMs, &args[4]);
            else napi_get_undefined(env, &args[4]);
            count = 5;
        }
        napi_call_function(env, receiver, callback, count, args, nullptr);
    } else if (frame) deleteFrame(env, frame, nullptr);
}

@interface PerchScreen : NSObject <SCStreamOutput, SCStreamDelegate>
- (instancetype)initWithCallback:(napi_threadsafe_function)callback;
- (void)start:(CGDirectDisplayID)displayID;
- (void)close;
- (void)setFrameRate:(uint32_t)fps;
@end

@implementation PerchScreen {
    napi_threadsafe_function _callback;
    SCStream *_stream;
    SCStreamConfiguration *_config;
    uint32_t _fps;
}

- (instancetype)initWithCallback:(napi_threadsafe_function)callback {
    if ((self = [super init])) { _callback = callback; _fps = 60; }
    return self;
}

- (void)failed {
    @synchronized (self) {
        if (_callback) napi_call_threadsafe_function(_callback, nullptr, napi_tsfn_nonblocking);
    }
}

- (void)start:(CGDirectDisplayID)displayID {
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
        completionHandler:^(SCShareableContent *content, NSError *error) {
        SCDisplay *target = nil;
        for (SCDisplay *display in content.displays) {
            if (display.displayID == displayID) { target = display; break; }
        }
        if (error || !target) { [self failed]; return; }

        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:target excludingWindows:@[]];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        CGDisplayModeRef mode = CGDisplayCopyDisplayMode(displayID);
        config.width = mode ? CGDisplayModeGetPixelWidth(mode) : target.width;
        config.height = mode ? CGDisplayModeGetPixelHeight(mode) : target.height;
        if (mode) CGDisplayModeRelease(mode);
        config.showsCursor = NO;
        config.pixelFormat = kCVPixelFormatType_32BGRA;
        config.queueDepth = 4;

        @synchronized (self) {
            if (!self->_callback) return;
            config.minimumFrameInterval = CMTimeMake(1, self->_fps);
            self->_config = config;
            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
            if (![stream addStreamOutput:self type:SCStreamOutputTypeScreen
                    sampleHandlerQueue:dispatch_queue_create("io.peerdesk.screen", DISPATCH_QUEUE_SERIAL) error:nil]) {
                [self failed];
                return;
            }
            self->_stream = stream;
            [stream startCaptureWithCompletionHandler:^(NSError *startError) {
                if (startError) [self failed];
            }];
        }
    }];
}

- (void)setFrameRate:(uint32_t)fps {
    @synchronized (self) {
        _fps = fps;
        if (!_stream || !_callback) return;
        SCStreamConfiguration *config = [_config copy];
        config.minimumFrameInterval = CMTimeMake(1, fps);
        _config = config;
        [_stream updateConfiguration:config completionHandler:^(NSError *error) {
            if (error) [self failed];
        }];
    }
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
    if (!pixels || !CVPixelBufferGetIOSurface(pixels)) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSNumber *status = [attachments.firstObject objectForKey:SCStreamFrameInfoStatus];
    if (!status || (status.integerValue != SCFrameStatusComplete && status.integerValue != SCFrameStatusStarted)) return;
    @synchronized (self) {
        if (!_callback) return;
        auto *frame = new ScreenFrame{CVPixelBufferRetain(pixels),
            static_cast<uint32_t>(CVPixelBufferGetWidth(pixels)), static_cast<uint32_t>(CVPixelBufferGetHeight(pixels)),
            CMSampleBufferGetPresentationTimeStamp(sample)};
        if (napi_call_threadsafe_function(_callback, frame, napi_tsfn_nonblocking) != napi_ok) {
            CVPixelBufferRelease(frame->pixels);
            delete frame;
        }
    }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error { [self failed]; }

- (void)close {
    SCStream *stream;
    @synchronized (self) {
        if (!_callback) return;
        napi_release_threadsafe_function(_callback, napi_tsfn_abort);
        _callback = nullptr;
        stream = _stream;
        _stream = nil;
    }
    [stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
    [stream stopCaptureWithCompletionHandler:nil];
}
@end

static napi_value stopScreen(napi_env env, napi_callback_info info) {
    void *data = nullptr;
    size_t count = 0;
    napi_get_cb_info(env, info, &count, nullptr, nullptr, &data);
    [(__bridge PerchScreen *)data close];
    return nullptr;
}

static void releaseScreen(napi_env, void *data, void *) {
    PerchScreen *screen = (__bridge_transfer PerchScreen *)data;
    [screen close];
}

static napi_value setScreenFrameRate(napi_env env, napi_callback_info info) {
    void *data = nullptr;
    napi_value arg;
    size_t count = 1;
    uint32_t fps = 0;
    napi_get_cb_info(env, info, &count, &arg, nullptr, &data);
    if (count == 1 && napi_get_value_uint32(env, arg, &fps) == napi_ok &&
        (fps == 30 || fps == 60 || fps == 90 || fps == 144)) {
        [(__bridge PerchScreen *)data setFrameRate:fps];
    }
    return nullptr;
}

napi_value startScreen(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2], name, stop, setFrameRate;
    uint32_t display;
    napi_threadsafe_function callback;
    if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2 ||
        napi_get_value_uint32(env, args[0], &display) != napi_ok) return nullptr;
    napi_create_string_utf8(env, "ScreenCaptureKit", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, args[1], nullptr, name, 2, 1, nullptr, nullptr, nullptr, emitFrame, &callback) != napi_ok) return nullptr;
    napi_unref_threadsafe_function(env, callback);
    PerchScreen *screen = [[PerchScreen alloc] initWithCallback:callback];
    void *data = (__bridge_retained void *)screen;
    napi_create_function(env, "stopScreen", NAPI_AUTO_LENGTH, stopScreen, data, &stop);
    napi_add_finalizer(env, stop, data, releaseScreen, nullptr, nullptr);
    napi_create_function(env, "setFrameRate", NAPI_AUTO_LENGTH, setScreenFrameRate, data, &setFrameRate);
    // Retain the owner while the setter exists so its callback data remains valid.
    void *setterOwner = (__bridge_retained void *)screen;
    napi_add_finalizer(env, setFrameRate, setterOwner, releaseScreen, nullptr, nullptr);
    napi_set_named_property(env, stop, "setFrameRate", setFrameRate);
    [screen start:display];
    return stop;
}
