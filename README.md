# TrackRelay

## Overview
TrackRelay is a prototype for a shared web experience where every connected user screen acts as a station along a railway. Trains represent user-initiated transitions, carrying data, status, and cues as they travel from one screen to the next, keeping everyone aligned in rhythm and narrative.

## Features
- **Screen-station metaphor** – each participant has a dedicated panel that can dispatch or receive a train, emphasizing live collaboration.
- **Train-based navigation** – interactions are chunked into trains (messages, scenes, or shared state) to make transitions feel deliberate and theatrical.
- **Signal-aware layout** – the interface will highlight which stations are sending or expecting trains, so collaborators can anticipate the next move.

## Architecture
- **Client**: a reactive SPA (likely React/Vue/Solid) that renders each connected screen as a station and animates train arrivals/departures.
- **Realtime transport**: WebSocket or WebRTC channels carry the train payloads, carrying metadata that tells each station how to update upon arrival.
- **Conductor service**: a lightweight backend orchestrates the trains, enforces ordering, and tracks participant presence.

## Getting Started
1. Clone the repo and switch to the `dev` branch (`git checkout dev`).
2. Install the dependencies for the chosen stack (e.g., `npm install` or `pnpm install`).
3. Start the dev server and open multiple screens to observe trains moving between them.

## Next Steps
- Draft the station UI patterns and define what data each train carries.
- Decide on the realtime transport (socket server, presence tracking, backpressure behavior).
- Sketch the train animation/state transitions so every screen feels responsive.
- Wire up the backend conductor to accept commands from one screen and broadcast them to others.

[dev branch](https://github.com/monty-gary/trackrelay/tree/dev) is the active workspace for ongoing work.
