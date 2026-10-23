import { useEffect, useState, Fragment } from "react";
import { localMediaUrl } from "../client";
function Media({ id, audio }: { id: string; audio: boolean }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl("");
    setFailed(false);
    localMediaUrl(id)
      .then((u) => {
        if (active) setUrl(u);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (!url || failed)
    return (
      <span className="muted">
        {failed
          ? `${audio ? "Audio" : "Image"} unavailable. Reconnect or download the deck again.`
          : "Loading media…"}
      </span>
    );
  return audio ? (
    <audio
      controls
      aria-label="Card audio"
      preload="none"
      src={url}
      onError={() => setFailed(true)}
    />
  ) : (
    <img
      className="card-media"
      src={url}
      alt="Flashcard image"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
export function CardContent({ text }: { text: string }) {
  const parts = text.split(/(\[\[(?:image|audio):[^\]]+\]\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[\[(image|audio):([^\]]+)\]\]$/);
        return m ? (
          <Media key={i} id={m[2]!} audio={m[1] === "audio"} />
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </>
  );
}
