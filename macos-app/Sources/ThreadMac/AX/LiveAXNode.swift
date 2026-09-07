import Foundation

#if canImport(ApplicationServices)
import ApplicationServices

/// The real `AXNode`: a thin, lazy wrapper over one `AXUIElement`. Every accessor is a synchronous
/// `AXUIElementCopyAttributeValue`; children are re-read each time `axChildren` is touched so the
/// view never goes stale against a live, changing UI. Nothing here is exercised in CI (the runner
/// has no Accessibility permission and no target app) -- it is covered only by the manual harness.
struct LiveAXNode: AXNode {
    let element: AXUIElement

    init(_ element: AXUIElement) { self.element = element }

    /// The application-level element for a running process, the entry point for a whole app tree.
    static func application(pid: pid_t) -> LiveAXNode {
        LiveAXNode(AXUIElementCreateApplication(pid))
    }

    private func copyValue(_ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        return err == .success ? value : nil
    }

    func axString(_ attribute: String) -> String? {
        guard let raw = copyValue(attribute) else { return nil }
        if let s = raw as? String { return s }
        // `kAXValueAttribute` on a text element is usually a plain String, but some elements hand
        // back an AXValue box or a number; stringify what we reasonably can.
        if CFGetTypeID(raw) == AXValueGetTypeID() { return nil }
        if let n = raw as? NSNumber { return n.stringValue }
        return nil
    }

    var axRole: String { axString(AXAttribute.role) ?? "" }
    var axSubrole: String? { axString(AXAttribute.subrole) }
    var axTitle: String? { axString(AXAttribute.title) }
    var axDescription: String? { axString(AXAttribute.description) }
    var axIdentifier: String? { axString(AXAttribute.identifier) }
    var axValue: String? { axString(AXAttribute.value) }

    var axChildren: [AXNode] {
        guard let raw = copyValue(AXAttribute.children) else { return [] }
        guard let arr = raw as? [AXUIElement] else { return [] }
        return arr.map { LiveAXNode($0) }
    }
}
#endif
