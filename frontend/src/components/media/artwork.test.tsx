import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { Artwork, forgetArtwork } from "@/components/media/artwork";

const image = (container: HTMLElement) => container.querySelector("img");

describe("Artwork", () => {
  afterEach(forgetArtwork);

  it("fades the art in over the placeholder on first load", () => {
    const { container } = render(
      <Artwork src="https://art.test/a.jpg" title="Low Tide" showTitle />,
    );

    expect(image(container)).toHaveClass("opacity-0");
    expect(screen.getByText("Low Tide")).toBeInTheDocument();
    fireEvent.load(image(container)!);
    expect(image(container)).not.toHaveClass("opacity-0");
    expect(image(container)).toHaveClass("transition-opacity");
    expect(screen.queryByText("Low Tide")).toBeNull();
  });

  it("shows art it has loaded before at once when a card mounts again", () => {
    const first = render(<Artwork src="https://art.test/a.jpg" title="Low Tide" showTitle />);
    fireEvent.load(image(first.container)!);
    first.unmount();

    const { container } = render(
      <Artwork src="https://art.test/a.jpg" title="Low Tide" showTitle />,
    );
    expect(image(container)).not.toHaveClass("opacity-0");
    expect(image(container)).not.toHaveClass("transition-opacity");
    expect(screen.queryByText("Low Tide")).toBeNull();
  });

  it("doesn't fetch broken art again", () => {
    const first = render(<Artwork src="https://art.test/gone.jpg" title="Undertow" showTitle />);
    fireEvent.error(image(first.container)!);
    expect(image(first.container)).toBeNull();
    first.unmount();

    const { container } = render(
      <Artwork src="https://art.test/gone.jpg" title="Undertow" showTitle />,
    );
    expect(image(container)).toBeNull();
    expect(screen.getByText("Undertow")).toBeInTheDocument();
  });
});
