import dynamic from "next/dynamic";

// The atlas drives a canvas + ResizeObserver + pointer events; browser-only.
const CitationAtlas = dynamic(() => import("../components/CitationAtlas"), {
  ssr: false,
});

export default function Home() {
  return <CitationAtlas />;
}
