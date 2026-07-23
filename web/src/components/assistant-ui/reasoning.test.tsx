import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { Reasoning } from "./reasoning";

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

    expect(screen.getByText("Inspecting how terminal metadata is registered")).not.toBeNull();
    // No visible "Reasoning" text, but the screen-reader label remains.
    expect(screen.queryByText("Reasoning", { selector: ":not(.sr-only)" })).toBeNull();
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

  it("shows the complete original content when expanded", () => {
    const full = "First paragraph.\n\nSecond paragraph with **bold** text.";
    render(
      <Reasoning.Root defaultOpen={false}>
        <Reasoning.Trigger text={full} />
        <Reasoning.Content>
          <Reasoning.Text>{full}</Reasoning.Text>
        </Reasoning.Content>
      </Reasoning.Root>,
    );

    // Content is initially collapsed and not present in the DOM.
    expect(document.querySelector('[data-slot="reasoning-text-content"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show reasoning/i }));

    const content = document.querySelector('[data-slot="reasoning-content"]');
    expect(content).not.toBeNull();
    expect(content?.getAttribute("data-state")).toBe("open");
    const textContent = content?.textContent ?? "";
    expect(textContent).toContain("Second paragraph with **bold** text.");
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
});
