// The hero's product film — a placeholder, and deliberately an obvious one.
//
// The film does not exist yet. The landing handoff is explicit that this
// designed placeholder state SHIPS AS IS rather than being filled with a fake
// screenshot or a stock clip: "an obvious placeholder is more honest". It
// replaced a mocked browser window, and that decision stands.
//
// TO DROP IN THE REAL FILM: put the file somewhere we serve and pass `src`
// (and ideally `poster`) — the header strip, the 16:10 well and the scrub row
// stay, and the well becomes a native <video>:
//
//   <VideoPlaceholder src="/portal/product.mp4" poster="/portal/poster.jpg" />
//
// Self-hosted, never a YouTube iframe: an embed would be the only third-party
// request on the page and it would track the reader before they agreed to
// anything.
export function VideoPlaceholder({
  src,
  poster,
  onSeeHow,
}: {
  src?: string;
  poster?: string;
  onSeeHow?: () => void;
}) {
  return (
    <figure className="ld-film" style={{ margin: 0 }}>
      <div className="ld-film-head">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ld-film-dot" aria-hidden="true" />
          Product film
        </span>
        <span>90 sec</span>
      </div>

      {src ? (
        <video
          src={src}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <>
          <button
            type="button"
            className="ld-film-well"
            onClick={onSeeHow}
            aria-label="Product film: one job, start to finish. Not shot yet — skip to how it works."
          >
            <span className="ld-film-ring" aria-hidden="true">
              <span />
            </span>
            <span className="ld-film-title">One job, start to finish</span>
            <span className="ld-film-note">Film not shot yet</span>
            <span className="ld-tick ld-tick-tl" aria-hidden="true" />
            <span className="ld-tick ld-tick-br" aria-hidden="true" />
          </button>
          <div className="ld-film-scrub" aria-hidden="true">
            <span>00:00</span>
            <span className="ld-film-track" />
            <span>01:30</span>
          </div>
        </>
      )}
    </figure>
  );
}
