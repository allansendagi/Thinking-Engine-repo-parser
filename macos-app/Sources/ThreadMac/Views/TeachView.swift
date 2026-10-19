import SwiftUI

/// The once-a-day invitation at the top of Recent. Same quiet shape as the resume bar.
struct LessonInvite: View {
    @EnvironmentObject var appState: AppState
    @State private var hover = false

    var body: some View {
        let n = appState.lesson?.questions.count ?? 0
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text("Help Thread learn how you think")
                    .font(.system(size: 12, weight: .medium)).kerning(-0.06)
                    .foregroundStyle(Theme.ink(0.85)).lineLimit(1)
                Text("\(n) quick questions · about a minute")
                    .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4)).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button("Start") { Task { await appState.startLesson() } }
                .buttonStyle(.plain)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Theme.accent)
            Button("Not now") { withAnimation(.easeOut(duration: 0.16)) { appState.markLessonOffered() } }
                .buttonStyle(.plain)
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.ink(0.36))
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.ink(hover ? 0.06 : 0.045)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.ink(0.09), lineWidth: 0.5))
        .padding(.horizontal, 12).padding(.bottom, 8)
        .onHover { hover = $0 }
        .transition(.opacity)
    }
}

/// Teach Thread: one question at a time, keyboard first. Return = Keep / Same, Delete = Not an
/// idea / Different, Space = Skip, Escape = done.
struct TeachThreadView: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var focused: Bool
    /// The first lesson opens with a short "how Thread learns"; never again after that.
    @AppStorage("thread.lesson.introSeen") private var introSeen = false

    private var questions: [LessonQuestion] { appState.lessonQuestions }
    private var index: Int { appState.lessonIndex }
    private var finished: Bool { index >= questions.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.6)
            ZStack {
                if !introSeen {
                    intro.transition(.opacity)
                } else if finished {
                    done.transition(.opacity)
                } else {
                    question(questions[index])
                        .id(questions[index].id)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .offset(x: 14)),
                            removal: .opacity.combined(with: .offset(x: -14))
                        ))
                }
            }
            .animation(.easeOut(duration: 0.2), value: index)
            .animation(.easeOut(duration: 0.2), value: introSeen)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onAppear { focused = true }
        .onKeyPress(.escape) { appState.closeLesson(); return .handled }
        .onKeyPress(.return) {
            if !introSeen { introSeen = true } else { primary() }
            return .handled
        }
        .onKeyPress(.delete) { secondary(); return .handled }
        .onKeyPress(.space) { answer(.skip); return .handled }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 10) {
            Button { appState.closeLesson() } label: {
                Image(systemName: "xmark").font(.system(size: 10.5, weight: .semibold))
            }
            .buttonStyle(.plain).foregroundStyle(Theme.ink(0.45))
            .help("Done (Esc)")
            Text("Teach Thread").font(.system(size: 13, weight: .semibold)).kerning(-0.08)
            Spacer()
            if introSeen && !finished {
                Text("\(index + 1) of \(questions.count)")
                    .font(.system(size: 11.5)).monospacedDigit()
                    .foregroundStyle(Theme.ink(0.4))
            }
        }
        .padding(.horizontal, 14).frame(height: 40)
        .overlay(alignment: .bottom) {
            GeometryReader { g in
                Rectangle().fill(Theme.accent)
                    .frame(width: questions.isEmpty ? 0 : g.size.width * CGFloat(min(index, questions.count)) / CGFloat(questions.count), height: 2)
                    .animation(.easeOut(duration: 0.25), value: index)
            }
            .frame(height: 2)
        }
    }

    // MARK: how it works (first time only)

    private var intro: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Thread learns how you think")
                .font(.system(size: 17, weight: .semibold)).kerning(-0.25)
            Text("What counts as an idea is personal. A few answers teach Thread what matters to you — and it asks only about the ideas it's least sure of, so each one counts.")
                .font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.6))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 14) {
                introRow("checkmark.circle.fill", "Keep", "Thread holds on to ideas like this one.")
                introRow("xmark.circle.fill", "Not an idea", "Thread shows you fewer like this.")
                introRow("equal.circle.fill", "Same idea?", "Teaches Thread how you group your thinking.")
            }
            Text("You can teach Thread any time, too: right-click any idea and choose Keep or Not an idea.")
                .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.45))
                .fixedSize(horizontal: false, vertical: true)
            Button { introSeen = true } label: { Text("Start").frame(maxWidth: .infinity) }
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .padding(20)
    }

    private func introRow(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(Theme.accent)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(Theme.ink(0.55))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: one question

    @ViewBuilder private func question(_ q: LessonQuestion) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            switch q {
            case .idea(let i, let unsure):
                eyebrow(unsure ? "Thread isn't sure — is this worth keeping?" : "Worth keeping?")
                ideaCard(i)
                buttons(secondary: "Not an idea", secondaryKey: "⌫", primary: "Keep", primaryKey: "↩")
            case .pair(let a, let b):
                eyebrow("Same idea, or just the same subject?")
                VStack(spacing: 8) {
                    ideaCard(a)
                    Text("and").font(.system(size: 11)).foregroundStyle(Theme.ink(0.35))
                    ideaCard(b)
                }
                buttons(secondary: "Different ideas", secondaryKey: "⌫", primary: "Same idea", primaryKey: "↩")
            }
            if let err = appState.lessonError {
                Text(err).font(.system(size: 11)).foregroundStyle(.red)
            }
        }
        .padding(16)
    }

    private func eyebrow(_ s: String) -> some View {
        Text(s).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink(0.5))
    }

    private func ideaCard(_ i: LessonIdea) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(cleanIdeaTitle(i.title, fallback: i.statement))
                .font(.system(size: 14.5, weight: .semibold)).kerning(-0.15)
                .foregroundStyle(Theme.ink(0.88))
                .fixedSize(horizontal: false, vertical: true)
            if i.statement != i.title {
                Text(deNarrate(i.statement))
                    .font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.62))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let meta = metaLine(displaySourceLabel(i.source), i.lastTouched)
            if !meta.isEmpty {
                Text(meta).font(.system(size: 11)).foregroundStyle(Theme.ink(0.38))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.cardCorner).fill(Theme.cardFill))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
    }

    private func buttons(secondary: String, secondaryKey: String, primary: String, primaryKey: String) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Button { secondaryAction() } label: {
                    Label(secondary, systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                .help("\(secondary) (\(secondaryKey))")
                Button { primaryAction() } label: {
                    Label(primary, systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .help("\(primary) (\(primaryKey))")
            }
            Button("Skip") { answer(.skip) }
                .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.4))
                .help("Skip (Space)")
        }
    }

    // MARK: answers

    private func answer(_ a: LessonAnswer) {
        guard !finished else { if a == .skip { appState.closeLesson() }; return }
        Task { await appState.answerLesson(a) }
    }

    private func primary() { finished ? appState.closeLesson() : primaryAction() }
    private func secondary() { if !finished { secondaryAction() } }

    private func primaryAction() {
        if case .pair = questions[index] { answer(.same) } else { answer(.keep) }
    }

    private func secondaryAction() {
        if case .pair = questions[index] { answer(.different) } else { answer(.notIdea) }
    }

    // MARK: done

    private var done: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 44))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Theme.accent)
            Text(questions.isEmpty ? "Nothing to ask right now" : appState.lessonAnswered == 0 ? "No answers this time" : "Thanks — Thread is learning")
                .font(.system(size: 16, weight: .semibold)).kerning(-0.2)
            Text(doneDetail)
                .font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.55))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 24)
            Button("Done") { appState.closeLesson() }
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .padding(.top, 6)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .padding(16)
    }

    private var doneDetail: String {
        if questions.isEmpty { return "Thread will ask when it's unsure about something new." }
        let learned = appState.lesson?.learned ?? 0
        var lines = ["Thread has learned from \(learned) of your answers."]
        if let kept = keptRateSentence(rate: appState.lesson?.acceptanceRate, sample: appState.lesson?.acceptanceSample) {
            lines.append(kept)
        }
        return lines.joined(separator: "\n")
    }
}
