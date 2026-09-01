import Carbon.HIToolbox
import AppKit

/// Registers a system-wide keyboard shortcut via the classic Carbon hotkey API
/// (RegisterEventHotKey). Deliberately NOT NSEvent.addGlobalMonitorForEvents or anything
/// Accessibility-based: this mechanism only asks to be told when a specific key combo is
/// pressed anywhere, which macOS has allowed without special permission since long before the
/// modern Accessibility/Input Monitoring privacy gates existed (predates them, and isn't
/// covered by them) -- it does not read or write into other applications the way Wispr's text
/// insertion does. That's a deliberate scope boundary: this file gets Thread a global "open the
/// recall panel" shortcut without requiring the Accessibility permission grant that inserting
/// text into other apps would need (a materially bigger, separate capability -- not built here).
///
/// UNVERIFIED interactively: compiles and links against the Command Line Tools SDK's Carbon
/// headers, but whether the hotkey actually fires on a real key press has not been confirmed --
/// there's no way to simulate a physical key press and observe the callback from this
/// environment. Verify by actually running the app and pressing the configured combo.
final class GlobalHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private let onTrigger: () -> Void
    private let id: UInt32

    private static var registry: [UInt32: GlobalHotKey] = [:]
    private static var nextId: UInt32 = 1
    private static var handlerInstalled = false

    /// keyCode: a virtual key code (see Carbon's Events.h, e.g. kVK_ANSI_T = 0x11).
    /// modifiers: a combination of cmdKey, shiftKey, optionKey, controlKey (Carbon constants).
    init?(keyCode: UInt32, modifiers: UInt32, onTrigger: @escaping () -> Void) {
        self.onTrigger = onTrigger
        self.id = GlobalHotKey.nextId
        GlobalHotKey.nextId += 1

        GlobalHotKey.installHandlerOnce()

        let hotKeyID = EventHotKeyID(signature: OSType(0x54687264), id: id) // 'Thrd'
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else { return nil }
        self.hotKeyRef = ref

        GlobalHotKey.registry[id] = self
    }

    private static func installHandlerOnce() {
        guard !handlerInstalled else { return }
        handlerInstalled = true

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, _ -> OSStatus in
                var hotKeyID = EventHotKeyID()
                let status = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )
                if status == noErr, let hotKey = GlobalHotKey.registry[hotKeyID.id] {
                    DispatchQueue.main.async { hotKey.onTrigger() }
                }
                return noErr
            },
            1,
            &eventType,
            nil,
            nil
        )
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        GlobalHotKey.registry[id] = nil
    }
}
