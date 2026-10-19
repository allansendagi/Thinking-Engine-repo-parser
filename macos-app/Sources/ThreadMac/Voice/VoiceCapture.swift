import AVFoundation
import Carbon.HIToolbox
import Foundation
import Speech

// MARK: - Shortcut

extension Notification.Name {
    /// Posted when the voice shortcut (or whether it is on) changes in Settings.
    static let threadVoiceShortcutChanged = Notification.Name("thread.voiceShortcutChanged")
}

/// The global "speak a thought" shortcut. Chosen to avoid the system's own (⌃Space / ⌃⌥Space switch
/// input sources) and the recall shortcuts.
enum VoiceShortcut: String, CaseIterable, Identifiable {
    case controlOptionV
    case controlOptionD
    case off

    private static let key = "thread.voiceShortcut"

    static var current: VoiceShortcut {
        get { UserDefaults.standard.string(forKey: key).flatMap(VoiceShortcut.init(rawValue:)) ?? .controlOptionV }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: key)
            NotificationCenter.default.post(name: .threadVoiceShortcutChanged, object: nil)
        }
    }

    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .controlOptionV: return "⌃⌥V"
        case .controlOptionD: return "⌃⌥D"
        case .off: return "Off"
        }
    }
    var keyCode: UInt32? {
        switch self {
        case .controlOptionV: return UInt32(kVK_ANSI_V)
        case .controlOptionD: return UInt32(kVK_ANSI_D)
        case .off: return nil
        }
    }
    var carbonModifiers: UInt32 { UInt32(controlKey | optionKey) }
}

// MARK: - Pure rules (unit-tested)

enum VoiceTranscript {
    /// The fewest words worth capturing: a stray "um" or a cough isn't a thought.
    static let minimumWords = 3
    /// A hold longer than this is hold-to-talk (release ends it); a quick tap toggles instead.
    static let holdThreshold: TimeInterval = 0.45
    /// The longest single capture; it ends and captures by itself at this point.
    static let maximumDuration: TimeInterval = 180

    static func clean(_ raw: String) -> String {
        raw.split(whereSeparator: \.isNewline).joined(separator: " ")
            .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace }).count
    }

    /// Releasing the key ends the capture only after a deliberate hold.
    static func releaseEndsCapture(heldFor: TimeInterval) -> Bool { heldFor >= holdThreshold }
}

// MARK: - Speech engine

enum VoiceAuthorization: Equatable {
    case ready
    case microphoneDenied
    case speechDenied
    case restricted
    /// This Mac can't recognise speech on the device, and Thread never sends audio away.
    case onDeviceUnavailable
    /// Not running as an installed app (tests, `swift run`): there are no permission strings.
    case unavailableHere
}

/// What the session needs from a speech recogniser, so the session can be tested without a
/// microphone.
@MainActor
protocol SpeechEngine: AnyObject {
    var onPartial: ((String) -> Void)? { get set }
    var onLevel: ((Float) -> Void)? { get set }
    /// Called once, with the best transcript, after `stop()` (or on an unrecoverable error).
    var onFinal: ((String) -> Void)? { get set }
    var onError: ((String) -> Void)? { get set }
    func authorize() async -> VoiceAuthorization
    func start() throws
    func stop()
    func cancel()
}

/// Apple's speech recogniser, forced on-device: audio never leaves the Mac.
@MainActor
final class AppleSpeechEngine: SpeechEngine {
    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onFinal: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var best = ""
    private var finished = false
    private var finalTimeout: DispatchWorkItem?

    private var recognizer: SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    /// Asking for microphone or speech access without the usage strings in Info.plist aborts the
    /// process, so only an installed app that carries them may ask.
    static var canAskForPermission: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
            && Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil
            && Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
    }

    func authorize() async -> VoiceAuthorization {
        guard Self.canAskForPermission else { return .unavailableHere }
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return .onDeviceUnavailable }
        let speech: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        switch speech {
        case .authorized: break
        case .restricted: return .restricted
        default: return .speechDenied
        }
        guard await AVCaptureDevice.requestAccess(for: .audio) else { return .microphoneDenied }
        return .ready
    }

    func start() throws {
        guard let recognizer, recognizer.supportsOnDeviceRecognition else {
            throw NSError(domain: "Thread.Voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "On-device speech recognition isn't available on this Mac."])
        }
        best = ""
        finished = false
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true   // the privacy promise: audio stays on this Mac
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        request = req

        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            req.append(buffer)
            let level = Self.level(of: buffer)
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onLevel?(level) } }
        }
        audio.prepare()
        try audio.start()

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let result {
                        self.best = result.bestTranscription.formattedString
                        self.onPartial?(self.best)
                        if result.isFinal { self.complete() }
                    }
                    if error != nil, !self.finished { self.complete() }
                }
            }
        }
    }

    func stop() {
        teardownAudio()
        request?.endAudio()
        // The recogniser delivers a final result shortly after audio ends; don't wait forever.
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.complete() } }
        finalTimeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: item)
    }

    func cancel() {
        finished = true
        finalTimeout?.cancel()
        teardownAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    private func complete() {
        guard !finished else { return }
        finished = true
        finalTimeout?.cancel()
        teardownAudio()
        task?.cancel()
        task = nil
        request = nil
        onFinal?(best)
    }

    private func teardownAudio() {
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
    }

    private static func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        let rms = (sum / Float(n)).squareRoot()
        return min(1, rms * 8)
    }
}

// MARK: - Session

/// One "speak a thought" interaction: listen, show the words as they come, and on finish hand the
/// text to the same capture path as pasting and the Services menu.
@MainActor
final class VoiceSession: ObservableObject {
    enum Phase: Equatable {
        case idle
        case requesting
        case listening
        case finishing
        case captured
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var transcript = ""
    @Published private(set) var level: Float = 0

    private let engine: SpeechEngine
    private let capture: (String) -> Bool
    private let now: () -> Date
    private var startedAt: Date?
    private var pressStartedListening = false
    private var autoStop: DispatchWorkItem?
    private var dismissWork: DispatchWorkItem?

    init(engine: SpeechEngine, now: @escaping () -> Date = Date.init, capture: @escaping (String) -> Bool) {
        self.engine = engine
        self.capture = capture
        self.now = now
        engine.onPartial = { [weak self] text in self?.transcript = text }
        engine.onLevel = { [weak self] l in self?.level = l }
        engine.onFinal = { [weak self] text in self?.finish(with: text) }
        engine.onError = { [weak self] message in self?.fail(message) }
    }

    var isActive: Bool {
        switch phase {
        case .requesting, .listening, .finishing: return true
        default: return false
        }
    }

    /// The shortcut went down.
    func press() {
        switch phase {
        case .listening:
            pressStartedListening = false
            stop()                         // a second press ends it
        case .idle, .captured, .failed:
            dismissWork?.cancel()
            Task { await begin() }
        case .requesting, .finishing:
            break
        }
    }

    /// The shortcut came back up, `heldFor` seconds after it went down.
    func release(heldFor: TimeInterval) {
        guard phase == .listening, pressStartedListening else { return }
        pressStartedListening = false
        if VoiceTranscript.releaseEndsCapture(heldFor: heldFor) { stop() }
    }

    /// Escape: throw the words away.
    func cancel() {
        autoStop?.cancel()
        engine.cancel()
        transcript = ""
        level = 0
        phase = .idle
    }

    private func begin() async {
        transcript = ""
        level = 0
        phase = .requesting
        switch await engine.authorize() {
        case .ready: break
        case .microphoneDenied: return fail("Thread needs the microphone. Turn it on in System Settings › Privacy & Security › Microphone.")
        case .speechDenied: return fail("Thread needs Speech Recognition. Turn it on in System Settings › Privacy & Security › Speech Recognition.")
        case .restricted: return fail("Speech recognition is turned off on this Mac.")
        case .onDeviceUnavailable: return fail("This Mac can't turn speech into text on the device, and Thread never sends your voice away.")
        case .unavailableHere: return fail("Voice capture runs from the installed Thread app.")
        }
        do {
            try engine.start()
        } catch {
            return fail(error.localizedDescription)
        }
        startedAt = now()
        pressStartedListening = true
        phase = .listening
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.stop() } }
        autoStop = work
        DispatchQueue.main.asyncAfter(deadline: .now() + VoiceTranscript.maximumDuration, execute: work)
    }

    /// Finish listening and capture what was said.
    func stop() {
        guard phase == .listening else { return }
        autoStop?.cancel()
        phase = .finishing
        engine.stop()
    }

    private func finish(with raw: String) {
        autoStop?.cancel()
        guard phase == .finishing || phase == .listening else { return }
        let text = VoiceTranscript.clean(raw.isEmpty ? transcript : raw)
        transcript = text
        guard VoiceTranscript.wordCount(text) >= VoiceTranscript.minimumWords else {
            return fail(text.isEmpty ? "Didn't catch anything." : "That was too short to capture.")
        }
        if capture(text) {
            phase = .captured
            scheduleDismiss()
        } else {
            fail("Open Thread and set it up first, then try again.")
        }
    }

    private func fail(_ message: String) {
        autoStop?.cancel()
        engine.cancel()
        level = 0
        phase = .failed(message)
        scheduleDismiss(after: 4)
    }

    private func scheduleDismiss(after seconds: TimeInterval = 1.6) {
        dismissWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.phase == .captured || { if case .failed = self.phase { return true } else { return false } }() {
                    self.phase = .idle
                    self.transcript = ""
                }
            }
        }
        dismissWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
}
