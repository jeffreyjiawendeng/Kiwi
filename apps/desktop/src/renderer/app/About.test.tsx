import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { About, AboutDialog } from "./About.js";
import type { RendererAbout, RendererBridge, RendererUpdateState } from "./bridge.js";

const about: RendererAbout = {
  appVersion: "0.1.0",
  electronVersion: "43.4.1",
  chromiumVersion: "142.0.0.0",
  nodeVersion: "22.20.0",
  platform: "win32",
  architecture: "x64",
  installType: "portable",
  protocolVersion: "1.0.0",
  buildIdentifier: "local",
  signed: false,
};

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("About", () => {
  it("shows every version the diagnostics contract lists", () => {
    render(<About about={about} />);
    for (const value of ["0.1.0", "43.4.1", "142.0.0.0", "22.20.0", "1.0.0", "local"]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("win32 x64")).toBeInTheDocument();
  });

  it("labels the install type in plain words", () => {
    render(<About about={about} />);
    expect(screen.getByText("Portable")).toBeInTheDocument();
  });

  it("says an unsigned build is unsigned, and where to get a genuine copy", () => {
    render(<About about={about} />);
    expect(screen.getByText(/not code signed/i)).toHaveTextContent(
      "publishes a checksum for every release",
    );
  });

  it("omits the warning once a build is signed", () => {
    render(<About about={{ ...about, signed: true }} />);
    expect(screen.queryByText(/not code signed/i)).not.toBeInTheDocument();
  });

  it("has an accessible section name", () => {
    render(<About about={about} />);
    expect(screen.getByRole("region", { name: "About Kiwi" })).toBeInTheDocument();
  });
});

describe("what About says about updates", () => {
  function shown(update: RendererUpdateState): string {
    render(<About about={about} update={update} onCheck={vi.fn()} onRestart={vi.fn()} />);
    return screen.getByRole("status").textContent ?? "";
  }

  it("says nothing about updates until it knows", () => {
    render(<About about={about} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("tells a portable user where the new version is, since it cannot fetch one", () => {
    expect(shown({ status: "off", reason: "portable" })).toContain("Download the new version");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says why a build packaged without a feed never checks", () => {
    expect(shown({ status: "off", reason: "no_feed" })).toContain("without an update feed");
  });

  it("says it is not checking while working offline", () => {
    expect(shown({ status: "paused" })).toContain("working offline");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a check when it has found nothing new", () => {
    expect(shown({ status: "idle", checked_at: "2026-09-18T12:00:00.000Z" })).toContain(
      "Kiwi is up to date",
    );
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
  });

  it("shows how far a download has got", () => {
    expect(shown({ status: "downloading", version: "1.0.1", percent: 42 })).toContain(
      "Downloading Kiwi 1.0.1 (42%)",
    );
  });

  it("offers a restart once an update is on disk", () => {
    expect(shown({ status: "ready", version: "1.0.1" })).toContain(
      "installs the next time Kiwi closes",
    );
    expect(screen.getByRole("button", { name: "Restart now" })).toBeInTheDocument();
  });

  it("says what went wrong and offers to try again", () => {
    expect(
      shown({ status: "failed", message: "HttpError: 404", checked_at: "2026-09-18T12:00:00Z" }),
    ).toContain("Could not check for updates: HttpError: 404");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("the About dialog", () => {
  function install(overrides: Partial<RendererBridge> = {}) {
    const bridge = {
      getAbout: vi.fn(async () => about),
      getUpdateState: vi.fn(async () => ({ status: "idle" as const, checked_at: null })),
      checkForUpdates: vi.fn(async () => ({ status: "ready" as const, version: "1.0.1" })),
      restartToUpdate: vi.fn(async () => true),
      ...overrides,
    };
    window.kiwiDesktop = bridge as unknown as RendererBridge;
    return bridge;
  }

  it("checks when asked and offers what the check found", async () => {
    const bridge = install();
    render(<AboutDialog onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restart now" }));

    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    expect(bridge.restartToUpdate).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    install();
    const onClose = vi.fn();
    render(<AboutDialog onClose={onClose} />);
    await screen.findByRole("region", { name: "About Kiwi" });

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
  });
});
