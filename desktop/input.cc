#include <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <unordered_map>
#include <unordered_set>

static const std::unordered_map<std::string, CGKeyCode> keyCodes = {
    {"KeyA", 0}, {"KeyB", 11}, {"KeyC", 8}, {"KeyD", 2}, {"KeyE", 14},
    {"KeyF", 3}, {"KeyG", 5}, {"KeyH", 4}, {"KeyI", 34}, {"KeyJ", 38},
    {"KeyK", 40}, {"KeyL", 37}, {"KeyM", 46}, {"KeyN", 45}, {"KeyO", 31},
    {"KeyP", 35}, {"KeyQ", 12}, {"KeyR", 15}, {"KeyS", 1}, {"KeyT", 17},
    {"KeyU", 32}, {"KeyV", 9}, {"KeyW", 13}, {"KeyX", 7}, {"KeyY", 16}, {"KeyZ", 6},
    {"Digit0", 29}, {"Digit1", 18}, {"Digit2", 19}, {"Digit3", 20}, {"Digit4", 21},
    {"Digit5", 23}, {"Digit6", 22}, {"Digit7", 26}, {"Digit8", 28}, {"Digit9", 25},
    {"Minus", 27}, {"Equal", 24}, {"BracketLeft", 33}, {"BracketRight", 30},
    {"Backslash", 42}, {"Semicolon", 41}, {"Quote", 39}, {"Backquote", 50},
    {"Comma", 43}, {"Period", 47}, {"Slash", 44}, {"Space", 49}, {"Tab", 48},
    {"Enter", 36}, {"Escape", 53}, {"Backspace", 51}, {"Delete", 117},
    {"ShiftLeft", 56}, {"ShiftRight", 60}, {"ControlLeft", 59}, {"ControlRight", 62},
    {"AltLeft", 58}, {"AltRight", 61}, {"MetaLeft", 55}, {"MetaRight", 54},
    {"ArrowLeft", 123}, {"ArrowRight", 124}, {"ArrowDown", 125}, {"ArrowUp", 126},
    {"Home", 115}, {"End", 119}, {"PageUp", 116}, {"PageDown", 121},
    {"F1", 122}, {"F2", 120}, {"F3", 99}, {"F4", 118}, {"F5", 96}, {"F6", 97},
    {"F7", 98}, {"F8", 100}, {"F9", 101}, {"F10", 109}, {"F11", 103}, {"F12", 111},
    {"Numpad0", 82}, {"Numpad1", 83}, {"Numpad2", 84}, {"Numpad3", 85},
    {"Numpad4", 86}, {"Numpad5", 87}, {"Numpad6", 88}, {"Numpad7", 89},
    {"Numpad8", 91}, {"Numpad9", 92}, {"NumpadEnter", 76}, {"NumpadDecimal", 65},
    {"NumpadAdd", 69}, {"NumpadSubtract", 78}, {"NumpadMultiply", 67}, {"NumpadDivide", 75},
};
static const std::unordered_map<CGKeyCode, CGEventFlags> modifiers = {
    {56, kCGEventFlagMaskShift}, {60, kCGEventFlagMaskShift},
    {59, kCGEventFlagMaskControl}, {62, kCGEventFlagMaskControl},
    {58, kCGEventFlagMaskAlternate}, {61, kCGEventFlagMaskAlternate},
    {55, kCGEventFlagMaskCommand}, {54, kCGEventFlagMaskCommand},
};
static const std::array<CGMouseButton, 3> mouseButtons = {kCGMouseButtonLeft, kCGMouseButtonCenter, kCGMouseButtonRight};
static const std::array<CGEventType, 3> mouseDown = {kCGEventLeftMouseDown, kCGEventOtherMouseDown, kCGEventRightMouseDown};
static const std::array<CGEventType, 3> mouseUp = {kCGEventLeftMouseUp, kCGEventOtherMouseUp, kCGEventRightMouseUp};
static const std::array<CGEventType, 3> mouseDrag = {kCGEventLeftMouseDragged, kCGEventOtherMouseDragged, kCGEventRightMouseDragged};

static std::unordered_set<CGKeyCode> pressed;
static std::array<bool, 3> buttons = {};
static std::array<int, 3> clicks = {};
static std::array<double, 3> lastClick = {};
static std::array<CGPoint, 3> lastClickPoint = {};
static CGPoint pointer = {};

static void post(CGEventRef event) {
    if (!event) return;
    CGEventFlags flags = 0;
    for (const auto &[key, flag] : modifiers) {
        if (pressed.count(key)) flags |= flag;
    }
    CGEventSetFlags(event, flags);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

static void keyboard(CGKeyCode code, bool down) {
    const bool alreadyPressed = pressed.count(code);
    if (!down && !alreadyPressed) return;
    if (down) pressed.insert(code);
    else pressed.erase(code);
    CGEventRef event = CGEventCreateKeyboardEvent(nullptr, code, down);
    if (!event) return;
    if (modifiers.count(code)) CGEventSetType(event, kCGEventFlagsChanged);
    if (down && alreadyPressed) CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, 1);
    post(event);
}

static void mouseButton(size_t index, bool down) {
    if (buttons[index] == down) return;
    buttons[index] = down;
    if (down) {
        const double now = CFAbsoluteTimeGetCurrent();
        const CGPoint prior = lastClickPoint[index];
        const bool close = std::hypot(pointer.x - prior.x, pointer.y - prior.y) < 5;
        clicks[index] = close && now - lastClick[index] < 0.45 ? std::min(3, clicks[index] + 1) : 1;
        lastClickPoint[index] = pointer;
        lastClick[index] = now;
    }
    const CGEventType type = down ? mouseDown[index] : mouseUp[index];
    CGEventRef event = CGEventCreateMouseEvent(nullptr, type, pointer, mouseButtons[index]);
    if (event) CGEventSetIntegerValueField(event, kCGMouseEventClickState, clicks[index]);
    post(event);
}

static napi_value reset(napi_env env, napi_callback_info) {
    for (size_t index = 0; index < buttons.size(); ++index) mouseButton(index, false);
    while (!pressed.empty()) keyboard(*pressed.begin(), false);
    lastClick.fill(0);
    return nullptr;
}

static napi_value input(napi_env env, napi_callback_info info) {
    std::array<napi_value, 6> args;
    size_t count = args.size();
    if (napi_get_cb_info(env, info, &count, args.data(), nullptr, nullptr) != napi_ok || count != args.size()) return nullptr;
    int32_t type;
    uint32_t display;
    if (napi_get_value_uint32(env, args[0], &display) != napi_ok ||
        napi_get_value_int32(env, args[1], &type) != napi_ok ||
        !CGDisplayIsActive(display)) return nullptr;

    if (type == 0) {
        char key[32];
        bool down;
        if (napi_get_value_string_utf8(env, args[4], key, sizeof(key), nullptr) == napi_ok &&
            napi_get_value_bool(env, args[5], &down) == napi_ok) {
            const auto found = keyCodes.find(key);
            if (found != keyCodes.end()) keyboard(found->second, down);
        }
        return nullptr;
    }

    double x, y;
    if (napi_get_value_double(env, args[2], &x) != napi_ok ||
        napi_get_value_double(env, args[3], &y) != napi_ok || !std::isfinite(x) || !std::isfinite(y)) return nullptr;
    if (type == 3) {
        const auto dx = static_cast<int32_t>(std::clamp(x, -1000.0, 1000.0));
        const auto dy = static_cast<int32_t>(std::clamp(y, -1000.0, 1000.0));
        if (dx || dy) post(CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitPixel, 2, -dy, -dx));
        return nullptr;
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) return nullptr;
    const CGRect bounds = CGDisplayBounds(display);
    if (CGRectIsEmpty(bounds)) return nullptr;
    pointer = CGPointMake(bounds.origin.x + x * (bounds.size.width - 1),
                          bounds.origin.y + y * (bounds.size.height - 1));
    if (type == 2) {
        uint32_t index;
        bool down;
        if (napi_get_value_uint32(env, args[4], &index) == napi_ok && index < buttons.size() &&
            napi_get_value_bool(env, args[5], &down) == napi_ok) mouseButton(index, down);
    } else if (type == 1) {
        const auto drag = std::find(buttons.begin(), buttons.end(), true);
        const size_t index = std::distance(buttons.begin(), drag);
        post(CGEventCreateMouseEvent(nullptr, index < buttons.size() ? mouseDrag[index] : kCGEventMouseMoved,
                                     pointer, index < buttons.size() ? mouseButtons[index] : kCGMouseButtonLeft));
    }
    return nullptr;
}

static napi_value lockScreen(napi_env env, napi_callback_info) {
    bool posted = false;
    if (AXIsProcessTrusted()) {
        auto down = CGEventCreateKeyboardEvent(nullptr, keyCodes.at("KeyQ"), true);
        auto up = CGEventCreateKeyboardEvent(nullptr, keyCodes.at("KeyQ"), false);
        if (down && up) {
            const auto flags = kCGEventFlagMaskControl | kCGEventFlagMaskCommand;
            CGEventSetFlags(down, flags);
            CGEventSetFlags(up, flags);
            CGEventPost(kCGHIDEventTap, down);
            CGEventPost(kCGHIDEventTap, up);
            posted = true;
        }
        if (down) CFRelease(down);
        if (up) CFRelease(up);
    }
    napi_value result;
    napi_get_boolean(env, posted, &result);
    return result;
}

napi_value clipboardState(napi_env, napi_callback_info);
napi_value clipboardRead(napi_env, napi_callback_info);
napi_value clipboardWrite(napi_env, napi_callback_info);
napi_value startScreen(napi_env, napi_callback_info);

NAPI_MODULE_INIT() {
    const napi_property_descriptor api[] = {
        {"input", nullptr, input, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"reset", nullptr, reset, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"lockScreen", nullptr, lockScreen, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"clipboardState", nullptr, clipboardState, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"clipboardRead", nullptr, clipboardRead, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"clipboardWrite", nullptr, clipboardWrite, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startScreen", nullptr, startScreen, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(api) / sizeof(api[0]), api);
    return exports;
}
