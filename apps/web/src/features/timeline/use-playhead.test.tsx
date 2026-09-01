import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { usePlayhead } from "./use-playhead";

function PlayheadHarness() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playhead = usePlayhead(videoRef, { durationMs: 90_000, timeupdateThrottleMs: 0 });
  return (
    <>
      <video ref={videoRef} aria-label="clock source" />
      <output data-testid="playhead-value">{playhead.mediaTimeMs}</output>
      <button type="button" onClick={() => playhead.seekToMediaTime(6_789)}>Seek to known time</button>
    </>
  );
}

describe("usePlayhead", () => {
  const descriptors: PropertyDescriptor[] = [];

  afterEach(() => {
    const descriptor = descriptors.pop();
    if (descriptor === undefined) return;
    if (descriptor.value === undefined) delete (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
    else Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", descriptor);
  });

  it("uses native currentTime for the throttled timeupdate fallback", () => {
    render(<PlayheadHarness />);
    const video = screen.getByLabelText("clock source") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });

    act(() => {
      video.currentTime = 12.345;
      fireEvent.timeUpdate(video);
    });

    expect(screen.getByTestId("playhead-value")).toHaveTextContent("12345");
    fireEvent.click(screen.getByRole("button", { name: "Seek to known time" }));
    expect(video.currentTime).toBe(6.789);
    expect(screen.getByTestId("playhead-value")).toHaveTextContent("6789");
  });

  it("reads currentTime rather than frame callback metadata when rVFC is available", () => {
    let callback: ((now: number, metadata: { readonly mediaTime: number }) => void) | undefined;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "requestVideoFrameCallback");
    descriptors.push(descriptor ?? {});
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
      configurable: true,
      value: (nextCallback: (now: number, metadata: { readonly mediaTime: number }) => void) => {
        callback = nextCallback;
        return 1;
      },
    });
    render(<PlayheadHarness />);
    const video = screen.getByLabelText("clock source") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 22.222 });

    act(() => callback?.(0, { mediaTime: 1.111 }));

    expect(screen.getByTestId("playhead-value")).toHaveTextContent("22222");
  });
});
