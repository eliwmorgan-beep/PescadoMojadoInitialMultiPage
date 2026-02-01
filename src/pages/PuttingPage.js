import React, { useEffect, useMemo, useState } from "react";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  runTransaction,
} from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "Pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

// scoring rule: 4 made = 5 pts, 3=3, 2=2, 1=1, 0=0
function pointsForMade(made) {
  const m = Number(made);
  if (Number.isNaN(m) || m <= 0) return 0;
  if (m === 1) return 1;
  if (m === 2) return 2;
  if (m === 3) return 3;
  return 5; // 4 or more
}

function poolLabel(pool) {
  if (pool === "A") return "A Pool";
  if (pool === "B") return "B Pool";
  return "C Pool";
}

export default function PuttingPage() {
  // --- palette / look (match Tags style) ---
  const COLORS = {
    navy: "#1b1f5a",
    blueLight: "#e6f3ff",
    orange: "#f4a83a",
    green: "#15803d",
    red: "#cc0000",
    text: "#0b1220",
    border: "#dbe9ff",
    panel: "#ffffff",
    soft: "#f6fbff",
  };

  const inputStyle = {
    padding: "10px 12px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 14,
    background: "#fff",
  };

  const buttonStyle = {
    padding: "10px 14px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    background: COLORS.orange,
    color: "#1a1a1a",
    fontWeight: 800,
    cursor: "pointer",
  };

  const smallButtonStyle = { ...buttonStyle, padding: "8px 12px" };

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // Putting data stored under leagues/{LEAGUE_ID}.putting
  const [putting, setPutting] = useState(null);

  // UI toggles
  const [setupOpen, setSetupOpen] = useState(true);
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);
  const [scoringOpen, setScoringOpen] = useState(true);

  // Admin setup inputs
  const [stationsInput, setStationsInput] = useState(9);
  const [roundsInput, setRoundsInput] = useState(2);

  // Check-in inputs
  const [playerName, setPlayerName] = useState("");
  const [playerPool, setPlayerPool] = useState("A");

  // Card creation
  const [selectedIds, setSelectedIds] = useState([]);
  const [autoCardSize, setAutoCardSize] = useState(4);

  // Scoring
  const [activeCardId, setActiveCardId] = useState("");
  const [activeRoundIndex, setActiveRoundIndex] = useState(1);
  const [stationMade, setStationMade] = useState([]); // length = stations

  // ----- subscribe -----
  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const first = await getDoc(leagueRef);
      if (!first.exists()) {
        // If the doc doesn't exist, initialize minimal structure + putting
        await setDoc(leagueRef, {
          putting: {
            settings: { stations: 9, rounds: 2, status: "setup" }, // setup | active
            players: [],
            cards: [],
            cardRounds: [],
          },
        });
      } else {
        // Ensure putting exists
        const data = first.data() || {};
        if (!data.putting) {
          await updateDoc(leagueRef, {
            putting: {
              settings: { stations: 9, rounds: 2, status: "setup" },
              players: [],
              cards: [],
              cardRounds: [],
            },
          });
        }
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const data = snap.data() || {};
        const p = data.putting || {
          settings: { stations: 9, rounds: 2, status: "setup" },
          players: [],
          cards: [],
          cardRounds: [],
        };

        setPutting(p);

        // Keep admin inputs synced
        setStationsInput(Number(p.settings?.stations || 9));
        setRoundsInput(Number(p.settings?.rounds || 2));

        // Keep stationMade sized correctly
        const st = Number(p.settings?.stations || 9);
        setStationMade((prev) => {
          const copy = Array.isArray(prev) ? [...prev] : [];
          while (copy.length < st) copy.push("");
          if (copy.length > st) copy.length = st;
          return copy;
        });
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  const status = putting?.settings?.status || "setup";
  const stations = Number(putting?.settings?.stations || 9);
  const roundsCount = Number(putting?.settings?.rounds || 2);
  const players = putting?.players || [];
  const cards = putting?.cards || [];
  const cardRounds = putting?.cardRounds || [];

  const playerById = useMemo(() => {
    const m = {};
    players.forEach((p) => (m[p.id] = p));
    return m;
  }, [players]);

  async function adminAction(action) {
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    await action();
  }

  // ----- admin setup -----
  async function saveSettings() {
    if (status !== "setup") {
      alert("Settings are locked after Begin Round.");
      return;
    }

    const st = Number(stationsInput);
    const rc = Number(roundsInput);
    if (!st || st < 1) return alert("Stations must be at least 1.");
    if (!rc || rc < 1) return alert("Rounds must be at least 1.");

    await adminAction(async () => {
      await updateDoc(leagueRef, {
        "putting.settings": { stations: st, rounds: rc, status: "setup" },
      });
    });
  }

  async function beginRound() {
    await adminAction(async () => {
      if (players.length < 2) {
        alert("Check in at least 2 players before starting.");
        return;
      }
      if (!cards.length) {
        alert("Create at least 1 card before starting.");
        return;
      }

      await updateDoc(leagueRef, {
        "putting.settings": { ...(putting.settings || {}), status: "active" },
      });
    });
  }

  async function resetPuttingLeague() {
    await adminAction(async () => {
      const ok = window.confirm(
        "Reset ALL putting league data (settings, players, cards, scores)?"
      );
      if (!ok) return;

      await updateDoc(leagueRef, {
        putting: {
          settings: { stations: 9, rounds: 2, status: "setup" },
          players: [],
          cards: [],
          cardRounds: [],
        },
      });

      setSelectedIds([]);
      setActiveCardId("");
      setActiveRoundIndex(1);
      setStationMade([]);
    });
  }

  // ----- check-in -----
  async function addPlayer() {
    if (status !== "setup") return alert("Check-in is locked after Begin Round.");

    const nm = (playerName || "").trim();
    if (!nm) return alert("Enter a player name.");

    const pool = playerPool; // A/B/C
    await updateDoc(leagueRef, {
      "putting.players": [...players, { id: uid(), name: nm, pool }],
    });

    setPlayerName("");
    setPlayerPool("A");
  }

  async function removePlayer(id) {
    if (status !== "setup") return alert("Players are locked after Begin Round.");

    await adminAction(async () => {
      const newPlayers = players.filter((p) => p.id !== id);

      // remove from cards too
      const newCards = cards
        .map((c) => ({
          ...c,
          playerIds: (c.playerIds || []).filter((pid) => pid !== id),
        }))
        .filter((c) => (c.playerIds || []).length > 0);

      await updateDoc(leagueRef, {
        "putting.players": newPlayers,
        "putting.cards": newCards,
      });
    });
  }

  // ----- cards -----
  function toggleSelect(id) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function createCard() {
    if (status !== "setup") return alert("Cards are locked after Begin Round.");

    if (selectedIds.length < 2) return alert("Select at least 2 players.");
    if (selectedIds.length > 4) return alert("Max 4 players per card.");

    const card = {
      id: uid(),
      playerIds: [...selectedIds],
      createdAt: new Date().toLocaleString(),
    };

    await updateDoc(leagueRef, {
      "putting.cards": [...cards, card],
    });

    setSelectedIds([]);
  }

  async function autoCreateCards() {
    if (status !== "setup") return alert("Cards are locked after Begin Round.");

    const size = Math.min(4, Math.max(2, Number(autoCardSize || 4)));
    const ids = players.map((p) => p.id);

    if (ids.length < 2) return alert("Not enough players to create cards.");

    const newCards = [];
    for (let i = 0; i < ids.length; i += size) {
      const chunk = ids.slice(i, i + size);
      if (chunk.length >= 2) {
        newCards.push({
          id: uid(),
          playerIds: chunk,
          createdAt: new Date().toLocaleString(),
        });
      }
    }

    await updateDoc(leagueRef, { "putting.cards": newCards });
    setSelectedIds([]);
  }

  async function deleteAllCards() {
    if (status !== "setup") return alert("Cards are locked after Begin Round.");

    await adminAction(async () => {
      const ok = window.confirm("Delete ALL cards (does not delete players)?");
      if (!ok) return;

      await updateDoc(leagueRef, {
        "putting.cards": [],
        "putting.cardRounds": [],
      });
    });
  }

  // ----- scoring -----
  function existingCardRound(cardId, roundIndex) {
    return cardRounds.find(
      (r) => r.cardId === cardId && Number(r.roundIndex) === Number(roundIndex)
    );
  }

  function stationPointsArray(madeArr) {
    return madeArr.map((m) => pointsForMade(m));
  }

  async function submitRound() {
    if (status !== "active") return alert("Admin has not begun the round yet.");
    if (!activeCardId) return alert("Select your card.");

    const roundIndex = Number(activeRoundIndex);
    if (!roundIndex || roundIndex < 1 || roundIndex > roundsCount) {
      return alert("Select a valid round number.");
    }

    const madeArr = Array.from({ length: stations }).map((_, i) =>
      Number(stationMade[i] ?? 0)
    );

    if (madeArr.some((n) => Number.isNaN(n) || n < 0 || n > 4)) {
      return alert("Each station must be a number from 0 to 4.");
    }

    const ptsArr = stationPointsArray(madeArr);
    const total = ptsArr.reduce((a, b) => a + b, 0);

    const already = existingCardRound(activeCardId, roundIndex);
    if (already) {
      const ok = window.confirm(
        `This card already submitted Round ${roundIndex}.\nOverwrite it?`
      );
      if (!ok) return;
    }

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(leagueRef);
      if (!snap.exists()) return;

      const data = snap.data() || {};
      const putting2 = data.putting || {};
      const rounds2 = putting2.cardRounds || [];

      const filtered = rounds2.filter(
        (r) =>
          !(
            r.cardId === activeCardId &&
            Number(r.roundIndex) === Number(roundIndex)
          )
      );

      const entry = {
        id: uid(),
        cardId: activeCardId,
        roundIndex,
        stationMade: madeArr,
        stationPoints: ptsArr,
        totalPoints: total,
        createdAt: new Date().toLocaleString(),
      };

      tx.update(leagueRef, {
        "putting.cardRounds": [...filtered, entry],
      });
    });

    alert(`Submitted Round ${roundIndex}: ${total} points.`);
  }

  // ----- leaderboards by pool -----
  const leaderboards = useMemo(() => {
    // totals per player
    const totals = {};
    players.forEach((p) => (totals[p.id] = 0));

    // card lookup
    const cardById = {};
    cards.forEach((c) => (cardById[c.id] = c));

    // Each card-round total is added to EACH player on that card
    for (const cr of cardRounds) {
      const c = cardById[cr.cardId];
      if (!c) continue;
      const ids = c.playerIds || [];
      ids.forEach((pid) => {
        totals[pid] = (totals[pid] || 0) + Number(cr.totalPoints || 0);
      });
    }

    const pools = { A: [], B: [], C: [] };
    players.forEach((p) => {
      const key = p.pool || "C";
      pools[key].push({
        id: p.id,
        name: p.name,
        pool: p.pool,
        points: totals[p.id] || 0,
      });
    });

    Object.keys(pools).forEach((k) => {
      pools[k].sort(
        (a, b) => b.points - a.points || a.name.localeCompare(b.name)
      );
    });

    return pools;
  }, [players, cards, cardRounds]);

  // ----- render -----
  if (!putting) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
          display: "flex",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ width: "100%", maxWidth: 760 }}>
          <Header />
          <div style={{ marginTop: 14, textAlign: "center", opacity: 0.7 }}>
            Loading Putting League…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
        display: "flex",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <div
          style={{
            textAlign: "center",
            background: COLORS.panel,
            borderRadius: 18,
            padding: 26,
            border: `2px solid ${COLORS.navy}`,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
          }}
        >
          <Header />

          <div
            style={{
              color: COLORS.green,
              marginTop: 14,
              marginBottom: 18,
              fontWeight: 900,
            }}
          >
            Putting League{" "}
            <span style={{ fontWeight: 800, opacity: 0.75 }}>
              • {status === "setup" ? "SETUP" : "LIVE"}
            </span>
          </div>

          {/* ADMIN SETUP */}
          <div
            style={{
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: 12,
              background: COLORS.soft,
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Admin Setup
              </div>
              <button
                onClick={() => setSetupOpen((v) => !v)}
                style={{
                  ...smallButtonStyle,
                  background: COLORS.orange,
                  border: `1px solid ${COLORS.navy}`,
                }}
              >
                {setupOpen ? "Hide" : "Show"}
              </button>
            </div>

            {setupOpen && (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    marginTop: 12,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 6,
                      }}
                    >
                      Stations
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={stationsInput}
                      onChange={(e) => setStationsInput(e.target.value)}
                      style={{ ...inputStyle, width: "100%" }}
                      disabled={status !== "setup"}
                    />
                  </div>

                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 6,
                      }}
                    >
                      Rounds
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={roundsInput}
                      onChange={(e) => setRoundsInput(e.target.value)}
                      style={{ ...inputStyle, width: "100%" }}
                      disabled={status !== "setup"}
                    />
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    marginTop: 12,
                  }}
                >
                  <button
                    onClick={saveSettings}
                    style={{
                      ...buttonStyle,
                      background: COLORS.green,
                      color: "white",
                      border: `1px solid ${COLORS.green}`,
                      flex: 1,
                      minWidth: 220,
                    }}
                    disabled={status !== "setup"}
                    title="Admin-only"
                  >
                    Save Settings
                  </button>

                  <button
                    onClick={beginRound}
                    style={{
                      ...buttonStyle,
                      background: status === "setup" ? COLORS.navy : "#aaa",
                      color: "white",
                      border: `1px solid ${COLORS.navy}`,
                      flex: 1,
                      minWidth: 220,
                      cursor: status === "setup" ? "pointer" : "not-allowed",
                    }}
                    disabled={status !== "setup"}
                    title="Admin-only"
                  >
                    Begin Round
                  </button>
                </div>

                <button
                  onClick={resetPuttingLeague}
                  style={{
                    ...smallButtonStyle,
                    marginTop: 10,
                    width: "100%",
                    background: COLORS.red,
                    color: "white",
                    border: `1px solid ${COLORS.red}`,
                  }}
                  title="Admin-only"
                >
                  Reset Putting League (Danger)
                </button>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  Scoring: enter “made putts” per station (0–4). Points:
                  0→0, 1→1, 2→2, 3→3, 4→5.
                </div>
              </>
            )}
          </div>

          {/* CHECK-IN */}
          <div
            style={{
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: 12,
              background: "#fff",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Player Check-In{" "}
                <span style={{ fontWeight: 800, opacity: 0.65 }}>
                  ({players.length})
                </span>
              </div>
              <button
                onClick={() => setCheckinOpen((v) => !v)}
                style={{
                  ...smallButtonStyle,
                  background: COLORS.orange,
                  border: `1px solid ${COLORS.navy}`,
                }}
              >
                {checkinOpen ? "Hide" : "Show"}
              </button>
            </div>

            {checkinOpen && (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    marginTop: 12,
                  }}
                >
                  <input
                    placeholder="Player name"
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    style={{ ...inputStyle, flex: 1, minWidth: 220 }}
                    disabled={status !== "setup"}
                  />

                  <select
                    value={playerPool}
                    onChange={(e) => setPlayerPool(e.target.value)}
                    style={{ ...inputStyle, minWidth: 160 }}
                    disabled={status !== "setup"}
                  >
                    <option value="A">A Pool</option>
                    <option value="B">B Pool</option>
                    <option value="C">C Pool</option>
                  </select>

                  <button
                    onClick={addPlayer}
                    style={{
                      ...buttonStyle,
                      background: COLORS.green,
                      color: "white",
                      border: `1px solid ${COLORS.green}`,
                      minWidth: 120,
                    }}
                    disabled={status !== "setup"}
                  >
                    Add
                  </button>
                </div>

                <div style={{ marginTop: 12 }}>
                  {players.length === 0 ? (
                    <div style={{ opacity: 0.7 }}>
                      No players checked in yet.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {players.map((p) => (
                        <div
                          key={p.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: `1px solid ${COLORS.border}`,
                            background: COLORS.soft,
                          }}
                        >
                          <div style={{ fontWeight: 900, color: COLORS.text }}>
                            {p.name}{" "}
                            <span style={{ fontWeight: 800, opacity: 0.7 }}>
                              • {poolLabel(p.pool)}
                            </span>
                          </div>

                          <button
                            onClick={() => removePlayer(p.id)}
                            style={{
                              ...smallButtonStyle,
                              background: "#fff",
                              border: `1px solid ${COLORS.border}`,
                            }}
                            disabled={status !== "setup"}
                            title="Admin-only"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {status !== "setup" && (
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 12,
                      color: COLORS.red,
                      fontWeight: 900,
                    }}
                  >
                    Check-in locked (round has started).
                  </div>
                )}
              </>
            )}
          </div>

          {/* CARDS */}
          <div
            style={{
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: 12,
              background: "#fff",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Cards{" "}
                <span style={{ fontWeight: 800, opacity: 0.65 }}>
                  ({cards.length})
                </span>
              </div>
              <button
                onClick={() => setCardsOpen((v) => !v)}
                style={{
                  ...smallButtonStyle,
                  background: COLORS.orange,
                  border: `1px solid ${COLORS.navy}`,
                }}
              >
                {cardsOpen ? "Hide" : "Show"}
              </button>
            </div>

            {cardsOpen && (
              <>
                {status === "setup" && (
                  <>
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                      Select up to 4 players (cross-pool allowed), then create a
                      card.
                    </div>

                    <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                      {players.map((p) => {
                        const checked = selectedIds.includes(p.id);
                        return (
                          <div
                            key={p.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 12,
                              border: `1px solid ${COLORS.border}`,
                              background: checked ? "#fff7e6" : COLORS.soft,
                              cursor: "pointer",
                            }}
                            onClick={() => toggleSelect(p.id)}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSelect(p.id)}
                              />
                              <div style={{ fontWeight: 900 }}>
                                {p.name}{" "}
                                <span style={{ fontWeight: 800, opacity: 0.7 }}>
                                  ({p.pool})
                                </span>
                              </div>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                              {checked ? "Selected" : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        marginTop: 12,
                      }}
                    >
                      <button
                        onClick={createCard}
                        style={{
                          ...buttonStyle,
                          background: COLORS.navy,
                          color: "white",
                          border: `1px solid ${COLORS.navy}`,
                          flex: 1,
                          minWidth: 220,
                        }}
                      >
                        Create Card ({selectedIds.length}/4)
                      </button>

                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 12,
                          padding: 10,
                          background: COLORS.soft,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 900,
                            color: COLORS.navy,
                          }}
                        >
                          Auto size
                        </div>
                        <select
                          value={autoCardSize}
                          onChange={(e) =>
                            setAutoCardSize(Number(e.target.value))
                          }
                          style={{ ...inputStyle, width: 90 }}
                        >
                          <option value={4}>4</option>
                          <option value={3}>3</option>
                          <option value={2}>2</option>
                        </select>
                      </div>

                      <button
                        onClick={autoCreateCards}
                        style={{
                          ...buttonStyle,
                          background: COLORS.orange,
                          border: `1px solid ${COLORS.navy}`,
                          flex: 1,
                          minWidth: 220,
                        }}
                      >
                        Auto-Create Cards
                      </button>

                      <button
                        onClick={deleteAllCards}
                        style={{
                          ...smallButtonStyle,
                          background: "#fff",
                          border: `1px solid ${COLORS.border}`,
                          width: "100%",
                        }}
                        title="Admin-only"
                      >
                        Delete All Cards
                      </button>
                    </div>
                  </>
                )}

                <div style={{ marginTop: 12 }}>
                  {cards.length === 0 ? (
                    <div style={{ opacity: 0.7 }}>No cards created yet.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      {cards.map((c, idx) => (
                        <div
                          key={c.id}
                          style={{
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: 14,
                            padding: 12,
                            background: COLORS.soft,
                          }}
                        >
                          <div style={{ fontWeight: 900, color: COLORS.navy }}>
                            Card {idx + 1}
                            <span style={{ fontWeight: 800, opacity: 0.65 }}>
                              {" "}
                              • {(c.playerIds || []).length} players
                            </span>
                          </div>

                          <div style={{ marginTop: 6, fontSize: 14 }}>
                            {(c.playerIds || []).map((pid) => {
                              const p = playerById[pid];
                              return p ? (
                                <div key={pid} style={{ padding: "4px 0" }}>
                                  <strong>{p.name}</strong>{" "}
                                  <span style={{ opacity: 0.75 }}>
                                    ({p.pool})
                                  </span>
                                </div>
                              ) : (
                                <div
                                  key={pid}
                                  style={{ padding: "4px 0", opacity: 0.7 }}
                                >
                                  Unknown player
                                </div>
                              );
                            })}
                          </div>

                          {c.createdAt && (
                            <div
                              style={{
                                marginTop: 8,
                                fontSize: 12,
                                opacity: 0.7,
                              }}
                            >
                              Created: {c.createdAt}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {status !== "setup" && (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                    Cards locked (round has started).
                  </div>
                )}
              </>
            )}
          </div>

          {/* SCORING */}
          <div
            style={{
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: 12,
              background: "#fff",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Card Scoring
              </div>
              <button
                onClick={() => setScoringOpen((v) => !v)}
                style={{
                  ...smallButtonStyle,
                  background: COLORS.orange,
                  border: `1px solid ${COLORS.navy}`,
                }}
              >
                {scoringOpen ? "Hide" : "Show"}
              </button>
            </div>

            {scoringOpen && (
              <>
                {status !== "active" ? (
                  <div style={{ marginTop: 10, opacity: 0.75 }}>
                    Scoring becomes available after Admin clicks{" "}
                    <strong>Begin Round</strong>.
                  </div>
                ) : (
                  <>
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                      Select your card, choose the round, enter “made putts”
                      (0–4) for each station, then submit.
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        marginTop: 12,
                      }}
                    >
                      <select
                        value={activeCardId}
                        onChange={(e) => setActiveCardId(e.target.value)}
                        style={{ ...inputStyle, flex: 1, minWidth: 280 }}
                      >
                        <option value="">Select your card…</option>
                        {cards.map((c, idx) => {
                          const names = (c.playerIds || [])
                            .map((pid) => {
                              const p = playerById[pid];
                              return p ? `${p.name} (${p.pool})` : "Unknown";
                            })
                            .join(", ");
                          return (
                            <option key={c.id} value={c.id}>
                              Card {idx + 1}: {names}
                            </option>
                          );
                        })}
                      </select>

                      <select
                        value={activeRoundIndex}
                        onChange={(e) =>
                          setActiveRoundIndex(Number(e.target.value))
                        }
                        style={{ ...inputStyle, width: 160 }}
                      >
                        {Array.from({ length: roundsCount }).map((_, i) => (
                          <option key={i + 1} value={i + 1}>
                            Round {i + 1}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: COLORS.navy,
                          marginBottom: 8,
                        }}
                      >
                        Stations ({stations})
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(140px, 1fr))",
                          gap: 10,
                        }}
                      >
                        {Array.from({ length: stations }).map((_, i) => {
                          const made = Number(stationMade[i] ?? 0);
                          const pts = pointsForMade(made);

                          return (
                            <div
                              key={i}
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 14,
                                padding: 10,
                                background: COLORS.soft,
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: 900,
                                  color: COLORS.navy,
                                  marginBottom: 6,
                                }}
                              >
                                Station {i + 1}
                              </div>

                              <div
                                style={{
                                  display: "flex",
                                  gap: 8,
                                  alignItems: "center",
                                }}
                              >
                                <input
                                  type="number"
                                  min={0}
                                  max={4}
                                  value={stationMade[i] ?? ""}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setStationMade((prev) => {
                                      const copy = [...prev];
                                      copy[i] = v;
                                      return copy;
                                    });
                                  }}
                                  style={{ ...inputStyle, width: 80 }}
                                />
                                <div style={{ fontSize: 12, opacity: 0.8 }}>
                                  made (0–4)
                                </div>
                              </div>

                              <div style={{ marginTop: 8, fontSize: 12 }}>
                                Points:{" "}
                                <strong style={{ color: COLORS.green }}>
                                  {pts}
                                </strong>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div
                        style={{
                          marginTop: 12,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                          flexWrap: "wrap",
                          padding: 12,
                          borderRadius: 14,
                          border: `1px solid ${COLORS.border}`,
                          background: "#fff",
                        }}
                      >
                        <div style={{ fontWeight: 900, color: COLORS.navy }}>
                          Round Total:{" "}
                          <span style={{ color: COLORS.green }}>
                            {Array.from({ length: stations })
                              .map((_, i) => pointsForMade(stationMade[i] ?? 0))
                              .reduce((a, b) => a + b, 0)}
                          </span>
                        </div>

                        <button
                          onClick={submitRound}
                          style={{
                            ...buttonStyle,
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                            minWidth: 200,
                          }}
                        >
                          Submit Round
                        </button>
                      </div>

                      {activeCardId &&
                        existingCardRound(activeCardId, activeRoundIndex) && (
                          <div
                            style={{
                              marginTop: 10,
                              fontSize: 12,
                              color: COLORS.red,
                              fontWeight: 900,
                            }}
                          >
                            This card already submitted Round {activeRoundIndex}
                            . Submitting will overwrite.
                          </div>
                        )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* LIVE LEADERBOARDS */}
          <div
            style={{
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: 12,
              background: COLORS.soft,
            }}
          >
            <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 10 }}>
              Live Leaderboards (by Pool)
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              {["A", "B", "C"].map((pool) => {
                const rows = leaderboards[pool] || [];
                return (
                  <div
                    key={pool}
                    style={{
                      background: "#fff",
                      borderRadius: 14,
                      border: `1px solid ${COLORS.border}`,
                      padding: 12,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 8,
                      }}
                    >
                      {poolLabel(pool)}
                    </div>

                    {rows.length === 0 ? (
                      <div style={{ opacity: 0.7 }}>No players yet.</div>
                    ) : (
                      <div style={{ display: "grid", gap: 8 }}>
                        {rows.map((r, idx) => (
                          <div
                            key={r.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "10px 12px",
                              borderRadius: 12,
                              border: `1px solid ${COLORS.border}`,
                              background: COLORS.soft,
                            }}
                          >
                            <div style={{ fontWeight: 900 }}>
                              {idx + 1}. {r.name}
                            </div>
                            <div style={{ fontWeight: 900, color: COLORS.green }}>
                              {r.points} pts
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              Leaderboard math: each submitted <strong>card total</strong> is
              added to each player on that card. (If you want per-player scoring
              later, we can change the model.)
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            textAlign: "center",
            fontSize: 12,
            color: "#666",
          }}
        >
          Putting League • v1.0
        </div>
      </div>
    </div>
  );
}
