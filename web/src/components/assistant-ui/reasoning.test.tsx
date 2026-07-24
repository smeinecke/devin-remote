import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { Reasoning, ReasoningExcerptProvider } from "./reasoning";
import { splitReasoningExcerpt } from "@/utils";

describe("Reasoning", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a compact content preview instead of a visible Reasoning label", () => {
    render(
      <Reasoning.Root>
        <Reasoning.Trigger text="Inspecting how terminal metadata is registered" />
        <Reasoning.Content>
          <Reasoning.Text>content</Reasoning.Text>
        </Reasoning.Content>
      </Reasoning.Root>,
    );

    expect(
      screen.getByText("Inspecting how terminal metadata is registered"),
    ).not.toBeNull();
    // No visible "Reasoning" text, but the screen-reader label remains.
    expect(
      screen.queryByText("Reasoning", { selector: ":not(.sr-only)" }),
    ).toBeNull();
    const srOnly = screen.getByText("Reasoning", { selector: ".sr-only" });
    expect(srOnly).not.toBeNull();
    expect(screen.getByRole("button", { name: /Show reasoning/i })).not.toBeNull();
  });

  it("does not render an empty reasoning card", () => {
    const { container } = render(
      <Reasoning.Root>
        <Reasoning.Trigger text="   " />
        <Reasoning.Content>
          <Reasoning.Text>content</Reasoning.Text>
        </Reasoning.Content>
      </Reasoning.Root>,
    );

    expect(container.querySelector('[data-slot="reasoning-trigger"]')).toBeNull();
  });

  it("visually truncates long reasoning with an ellipsis", () => {
    const longText = "A ".repeat(300);
    render(
      <Reasoning.Root>
        <Reasoning.Trigger text={longText} />
      </Reasoning.Root>,
    );

    const preview = screen.getByText(/A A A/);
    expect(preview.textContent).toMatch(/…$/);
    expect(preview.textContent!.length).toBeLessThanOrEqual(220);
  });

  it("shows the continuation when expanded without duplicating the preview", () => {
    const source =
      "The grep output is also weird because it shows line numbers like 27, 293, 295, 371, 373, plus additional markers that do not correspond to actual source locations in the file we are inspecting. " +
      "The output format has `> 29` for SessionChat and `>295` etc, which means the file content is shifted compared to the line numbers shown in the grep result. " +
      "It seems the file has export default function ChatView at line 295, so the component definition lives much later than the imports at the top.";

    const excerpt = splitReasoningExcerpt(source);

    render(
      <ReasoningExcerptProvider excerpt={excerpt}>
        <Reasoning.Root defaultOpen={false}>
          <Reasoning.Trigger />
          <Reasoning.Content>
            <Reasoning.Text />
          </Reasoning.Content>
        </Reasoning.Root>
      </ReasoningExcerptProvider>,
    );

    // Trigger shows the preview with an ellipsis.
    const trigger = screen.getByRole("button", { name: /Show reasoning/i });
    expect(trigger.textContent).toMatch(/…$/);

    // Expand the reasoning.
    fireEvent.click(trigger);

    const content = document.querySelector('[data-slot="reasoning-content"]');
    expect(content).not.toBeNull();
    expect(content?.getAttribute("data-state")).toBe("open");

    const contentText = content?.textContent ?? "";
    // The expanded body should contain the continuation text.
    expect(contentText).toContain(
      "It seems the file has export default function ChatView at line 295",
    );
    // The preview text should not be repeated in the expanded body.
    expect(contentText).not.toContain(
      "The grep output is also weird because it shows line numbers",
    );
    expect(contentText).not.toContain(
      "plus additional markers that do not correspond to actual source locations",
    );
  });

  it("updates the preview when the reasoning text changes", () => {
    const { rerender } = render(
      <Reasoning.Root>
        <Reasoning.Trigger text="initial" />
      </Reasoning.Root>,
    );

    expect(screen.getByText("initial")).not.toBeNull();

    rerender(
      <Reasoning.Root>
        <Reasoning.Trigger text="updated reasoning preview" />
      </Reasoning.Root>,
    );

    expect(screen.getByText("updated reasoning preview")).not.toBeNull();
  });

  it("does not show a chevron or expand when reasoning fits in the preview", () => {
    const source = "Short reasoning text.";
    const excerpt = splitReasoningExcerpt(source);

    render(
      <ReasoningExcerptProvider excerpt={excerpt}>
        <Reasoning.Root>
          <Reasoning.Trigger />
          <Reasoning.Content>
            <Reasoning.Text />
          </Reasoning.Content>
        </Reasoning.Root>
      </ReasoningExcerptProvider>,
    );

    const trigger = screen.getByRole("button", { name: /Show reasoning/i }) as HTMLButtonElement;
    expect(trigger.textContent).not.toMatch(/…$/);
    expect(
      trigger.querySelector('[data-slot="reasoning-trigger-chevron"]'),
    ).toBeNull();
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.disabled).toBe(true);

    // No continuation content is rendered.
    expect(document.querySelector('[data-slot="reasoning-text-content"]')).toBeNull();
  });

  it("keeps the split stable while streaming and appends new text to the continuation", () => {
    const base =
      "The grep output is also weird because it shows line numbers like 27, 293, 295, 371, 373, plus additional markers that do not correspond to actual source locations. ";
    const first = base + "First continuation sentence.";
    const second = first + " Second continuation sentence.";

    const excerpt1 = splitReasoningExcerpt(first);
    const excerpt2 = splitReasoningExcerpt(second, 220, excerpt1.splitAt);

    // The split point should not move backward.
    expect(excerpt2.splitAt).toBeGreaterThanOrEqual(excerpt1.splitAt ?? 0);
    // The preview text should be identical in both excerpts.
    expect(excerpt2.displayPreview).toBe(excerpt1.displayPreview);
    // New text is appended to the continuation.
    expect(excerpt2.continuation).toContain("Second continuation sentence.");
  });

  it("does not split inside Unicode surrogate pairs", () => {
    const emoji = "😀";
    const base =
      "The emoji appears in the reasoning text and must not be sliced in half. ";
    const source = base + emoji.repeat(200);
    const excerpt = splitReasoningExcerpt(source);

    const reconstructed = excerpt.preview + excerpt.continuation;
    expect(reconstructed).toBe(source);
    // Reconstructing the source should not introduce replacement characters.
    expect(reconstructed).not.toContain("\uFFFD");
  });

  it("does not split inside fenced code blocks", () => {
    const prefix =
      "This is a reasonably long preamble that will get us close to the preview limit before the code block begins.";
    const code =
      "\n\n```ts\nconst veryLongIdentifierNameThatWouldNormallyBePastThePreviewBoundaryAndThenSomeExtraCharactersToMakeItDefinitelyLongerThanTwoHundredAndTwenty = 1;\nconst secondLineToMakeTheBlockEvenLonger = 2;\n```";
    const source = prefix + code + "\n\nAfter the block.";
    const excerpt = splitReasoningExcerpt(source);

    // The continuation should start with the fenced code block, not inside it.
    expect(excerpt.continuation.trimStart()).toMatch(/^```ts/);
    // The preview should not contain raw code block internals beyond the marker.
    expect(excerpt.displayPreview).not.toContain("const veryLongIdentifier");
  });

  it("does not split inside inline code spans or links", () => {
    const prefix =
      "This is a reasonably long preamble that will get us close to the preview limit before the markdown element begins. ";
    const inlineCode =
      "`veryLongInlineCodeIdentifierNameThatWouldNormallyBePastThePreviewBoundaryAndThenSomeExtraCharactersToMakeItDefinitelyLonger`";
    const link =
      "[this link](https://example.com/path?query=longValuePastThePreviewBoundaryAndThenSomeExtraCharacters)";
    const source = prefix + inlineCode + link + " and then more text after.";
    const excerpt = splitReasoningExcerpt(source);

    const continuation = excerpt.continuation.trimStart();
    // The continuation should start with the atomic element, not in the middle.
    expect(continuation.startsWith("`veryLongInline") || continuation.startsWith("[this link")).toBe(true);
    // The preview should not contain a partial identifier or URL.
    expect(excerpt.displayPreview).not.toContain("veryLongInline");
    expect(excerpt.displayPreview).not.toContain("longValuePastThePreviewBoundary");
  });
});

describe("splitReasoningExcerpt", () => {
  it("preview + continuation reconstructs the source text", () => {
    const source =
      "First sentence with some reasoning. Second sentence adds more detail. Third sentence finishes the thought.";
    const excerpt = splitReasoningExcerpt(source + " ".repeat(300));

    const reconstructed = excerpt.preview + excerpt.continuation;
    expect(reconstructed).toBe(source + " ".repeat(300));
  });

  it("returns a non-truncated excerpt for short text", () => {
    const source = "Short reasoning.";
    const excerpt = splitReasoningExcerpt(source);

    expect(excerpt.truncated).toBe(false);
    expect(excerpt.continuation).toBe("");
    expect(excerpt.preview).toBe(source);
    expect(excerpt.displayPreview).toBe(source);
  });
});
