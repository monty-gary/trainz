import { useEffect, useState } from 'react';

const PASS_INTERVAL_MS = 15_000;
const TRAIN_DURATION_MS = 7_000;

function App() {
  const [departedAt, setDepartedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setDepartedAt(Date.now());
    }, PASS_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="scene" aria-label="Animated railway scene">
        <div className="sky-glow" />
        <div className="sun" />
        <div className="hill hill-back" />
        <div className="hill hill-front" />

        <div className="track-zone">
          <div className="rail rail-top" />
          <div className="rail rail-bottom" />
          <div className="sleepers" />
        </div>

        <div
          className="train"
          key={departedAt}
          style={{
            animationDuration: `${TRAIN_DURATION_MS}ms`
          }}
          role="img"
          aria-label="Passenger train"
        >
          <div className="engine nose" />
          <div className="car car-1" />
          <div className="car car-2" />
          <div className="engine tail" />
          <div className="wheel-set wheel-front" />
          <div className="wheel-set wheel-middle" />
          <div className="wheel-set wheel-rear" />
        </div>

        <p className="scene-caption">trainz prototype: one express pass every 15 seconds</p>
      </section>
    </main>
  );
}

export default App;
