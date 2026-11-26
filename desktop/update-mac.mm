#import <AppKit/AppKit.h>
#include <cerrno>
#include <csignal>
#include <unistd.h>

static NSTextField *statusLabel;
static NSProgressIndicator *progress;

static void showStage(NSString *message) {
    dispatch_sync(dispatch_get_main_queue(), ^{
        statusLabel.stringValue = message;
    });
}

static BOOL processExists(pid_t pid) {
    return kill(pid, 0) == 0 || errno == EPERM;
}

static NSRunningApplication *launchApp(NSString *target, NSArray<NSString *> *arguments, NSError **error) {
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    __block NSRunningApplication *running;
    __block NSError *launchError;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
        config.createsNewApplicationInstance = YES;
        config.arguments = arguments;
        [NSWorkspace.sharedWorkspace openApplicationAtURL:[NSURL fileURLWithPath:target]
                                            configuration:config
                                          completionHandler:^(NSRunningApplication *app, NSError *failure) {
            running = app;
            launchError = failure;
            dispatch_semaphore_signal(finished);
        }];
    });
    dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
    if (error) *error = launchError;
    return running;
}

static void finish(NSString *failure) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [progress stopAnimation:nil];
        if (failure) {
            statusLabel.stringValue = @"更新未完成";
            NSAlert *alert = [[NSAlert alloc] init];
            alert.alertStyle = NSAlertStyleWarning;
            alert.messageText = @"更新未完成";
            alert.informativeText = failure;
            [alert addButtonWithTitle:@"确定"];
            [NSApp activateIgnoringOtherApps:YES];
            [alert runModal];
        }
        [NSApp terminate:nil];
    });
}

static void install(NSString *target, NSString *staged, pid_t oldPid, NSString *root) {
    NSFileManager *files = NSFileManager.defaultManager;
    NSError *error = nil;
    NSString *ready = [root stringByAppendingPathComponent:@"helper-ready"];
    NSString *backup = [root stringByAppendingPathComponent:@"previous.app"];
    NSString *failed = [root stringByAppendingPathComponent:@"failed.app"];
    NSString *ack = [root stringByAppendingPathComponent:@"app-ready"];
    NSString *stageArgument = [@"--update-stage=" stringByAppendingString:root.lastPathComponent];
    NSString *profileArgument = NSProcessInfo.processInfo.environment[@"PERCHREMOTE_UPDATE_PROFILE_ARG"];
    NSArray *originalArguments = profileArgument.length ? @[profileArgument] : @[];
    NSString *problem = nil;
    BOOL backedUp = NO;
    BOOL replaced = NO;
    NSRunningApplication *running = nil;

    if (![@"" writeToFile:ready atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
        finish(error.localizedDescription);
        return;
    }
    for (int attempt = 0; attempt < 150 && processExists(oldPid); attempt++) usleep(200000);
    if (processExists(oldPid)) {
        problem = @"旧版在 30 秒内未退出，请关闭后重新尝试。";
    } else {
        showStage(@"正在替换应用文件…");
        backedUp = [files moveItemAtPath:target toPath:backup error:&error];
        if (backedUp) replaced = [files moveItemAtPath:staged toPath:target error:&error];
        if (!replaced) problem = error.localizedDescription ?: @"无法替换应用文件。";
    }

    if (!problem) {
        showStage(@"正在启动新版…");
        running = launchApp(target, [originalArguments arrayByAddingObject:stageArgument], &error);
        if (!running) {
            problem = error.localizedDescription ?: @"无法启动新版。";
        } else {
            for (int attempt = 0; attempt < 300 && !running.terminated; attempt++) {
                if ([files fileExistsAtPath:ack]) break;
                usleep(200000);
            }
            if (![files fileExistsAtPath:ack] || running.terminated) problem = @"新版未能启动工作台。";
        }
    }

    if (!problem) {
        [files removeItemAtPath:root error:nil];
        finish(nil);
        return;
    }

    if (backedUp) {
        showStage(@"正在恢复旧版…");
        if (running && !running.terminated) {
            [running forceTerminate];
            for (int attempt = 0; attempt < 25 && !running.terminated; attempt++) usleep(200000);
        }
        if ((running && !running.terminated) ||
            (replaced && ![files moveItemAtPath:target toPath:failed error:&error]) ||
            ![files moveItemAtPath:backup toPath:target error:&error]) {
            finish([NSString stringWithFormat:@"%@\n旧版备份：%@", problem, backup]);
            return;
        }
    }
    if (!processExists(oldPid) && launchApp(target, originalArguments, nil)) {
        problem = [problem stringByAppendingString:@"\n已启动旧版。"];
    }
    [files removeItemAtPath:root error:nil];
    finish(problem);
}

int main(int argc, const char **argv) {
    if (argc != 5) return 1;
    @autoreleasepool {
        NSString *target = @(argv[1]);
        NSString *staged = @(argv[2]);
        pid_t oldPid = atoi(argv[3]);
        NSString *root = @(argv[4]);
        if (oldPid <= 1) return 1;

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 420, 154)
                                                        styleMask:NSWindowStyleMaskTitled
                                                          backing:NSBackingStoreBuffered defer:NO];
        window.title = @"PerchRemote 软件更新";
        window.releasedWhenClosed = NO;
        window.level = NSFloatingWindowLevel;
        statusLabel = [NSTextField labelWithString:@"正在等待旧版退出…"];
        statusLabel.font = [NSFont systemFontOfSize:18 weight:NSFontWeightSemibold];
        statusLabel.frame = NSMakeRect(28, 92, 364, 26);
        [window.contentView addSubview:statusLabel];
        progress = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(28, 59, 364, 18)];
        progress.indeterminate = YES;
        [window.contentView addSubview:progress];
        [progress startAnimation:nil];
        NSTextField *detail = [NSTextField labelWithString:@"更新完成后将自动打开工作台。"];
        detail.textColor = NSColor.secondaryLabelColor;
        detail.frame = NSMakeRect(28, 24, 364, 20);
        [window.contentView addSubview:detail];

        [window center];
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            install(target, staged, oldPid, root);
        });
        [NSApp run];
    }
}
