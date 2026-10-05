import Carbon.HIToolbox
import Foundation

extension Notification.Name {
    /// Posted when the user picks a different recall shortcut in Settings; the app delegate
    /// re-registers the global hotkey.
    static let threadRecallShortcutChanged = Notification.Name("thread.recallShortcutChanged")
}

/// The global "open recall" shortcut. ⌘⇧T stays the default (it's what the site and onboarding
/// teach), but it is also "Reopen closed tab" in Safari, Chrome, Arc and Firefox -- and a Carbon
/// hotkey wins system-wide -- so Settings offers alternatives that don't collide.
enum RecallShortcut: String, CaseIterable, Identifiable {
    case commandShiftT
    case controlOptionT
    case controlOptionSpace

    private static let key = "thread.recallShortcut"

    static var current: RecallShortcut {
        get {
            UserDefaults.standard.string(forKey: key).flatMap(RecallShortcut.init(rawValue:)) ?? .commandShiftT
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: key)
            NotificationCenter.default.post(name: .threadRecallShortcutChanged, object: nil)
        }
    }

    var id: String { rawValue }

    /// Glyphs as macOS draws them in menus.
    var symbol: String {
        switch self {
        case .commandShiftT: return "⌘⇧T"
        case .controlOptionT: return "⌃⌥T"
        case .controlOptionSpace: return "⌃⌥Space"
        }
    }

    var note: String? {
        switch self {
        case .commandShiftT: return "Also “Reopen closed tab” in browsers — Thread takes it while running."
        case .controlOptionT, .controlOptionSpace: return nil
        }
    }

    var keyCode: UInt32 {
        switch self {
        case .commandShiftT, .controlOptionT: return UInt32(kVK_ANSI_T)
        case .controlOptionSpace: return UInt32(kVK_Space)
        }
    }

    var carbonModifiers: UInt32 {
        switch self {
        case .commandShiftT: return UInt32(cmdKey | shiftKey)
        case .controlOptionT, .controlOptionSpace: return UInt32(controlKey | optionKey)
        }
    }
}
