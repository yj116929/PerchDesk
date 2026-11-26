#import <AppKit/AppKit.h>
#include <node_api.h>
#include <string>

napi_value clipboardState(napi_env env, napi_callback_info) {
    @autoreleasepool {
        napi_value result, sequence, foreground;
        napi_create_object(env, &result);
        napi_create_double(env, NSPasteboard.generalPasteboard.changeCount, &sequence);
        const pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        NSInteger window = 0;
        CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
        if (list) {
            for (NSDictionary *item in (__bridge NSArray *)list) {
                if ([item[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid &&
                    [item[(__bridge NSString *)kCGWindowLayer] intValue] == 0) {
                    window = [item[(__bridge NSString *)kCGWindowNumber] integerValue];
                    break;
                }
            }
            CFRelease(list);
        }
        const std::string target = std::to_string(pid) + ":" + std::to_string(window);
        napi_create_string_utf8(env, target.c_str(), target.size(), &foreground);
        napi_set_named_property(env, result, "sequence", sequence);
        napi_set_named_property(env, result, "foreground", foreground);
        return result;
    }
}

napi_value clipboardRead(napi_env env, napi_callback_info) {
    @autoreleasepool {
        NSArray<NSURL *> *urls = [NSPasteboard.generalPasteboard readObjectsForClasses:@[NSURL.class]
            options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
        napi_value result;
        napi_create_array(env, &result);
        uint32_t index = 0;
        for (NSURL *url in urls) {
            const char *path = url.path.UTF8String;
            if (!url.isFileURL || !path) continue;
            napi_value value;
            napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &value);
            napi_set_element(env, result, index++, value);
        }
        return result;
    }
}

napi_value clipboardWrite(napi_env env, napi_callback_info info) {
    @autoreleasepool {
        napi_value input, result;
        size_t arguments = 1;
        uint32_t count = 0;
        napi_get_boolean(env, false, &result);
        if (napi_get_cb_info(env, info, &arguments, &input, nullptr, nullptr) != napi_ok || arguments != 1 ||
            napi_get_array_length(env, input, &count) != napi_ok || count == 0) return result;
        NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithCapacity:count];
        for (uint32_t index = 0; index < count; ++index) {
            napi_value value;
            size_t length;
            if (napi_get_element(env, input, index, &value) != napi_ok ||
                napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return result;
            std::string path(length + 1, '\0');
            if (napi_get_value_string_utf8(env, value, path.data(), path.size(), nullptr) != napi_ok) return result;
            NSString *text = [NSString stringWithUTF8String:path.c_str()];
            if (!text.isAbsolutePath) return result;
            [urls addObject:[NSURL fileURLWithPath:text]];
        }
        NSPasteboard *board = NSPasteboard.generalPasteboard;
        [board clearContents];
        napi_get_boolean(env, [board writeObjects:urls], &result);
        return result;
    }
}
