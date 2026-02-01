import React, { useEffect, useMemo, useState } from "react";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "Pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function pointsForMade(made) {
  const m = Number(made);
  if (m >= 4) return 5;
  if (m === 3) return 3;
  if (m === 2) return 2;
  if (m === 1) return 1;
  return 0;
}

function clampMade(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(4, n));
}

export default function PuttingPage() {
  // --- Palette / look (match Tags theme) ---
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

  const smallButtonStyle = {
    ...buttonStyle,
    padding: "8px 12px",
  };

  // Firestore ref
  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // Putting league stored data
  const [putting, setPutting] = useState({
    settings: {
      stations: 9,
      rounds: 1,
      locked: false,
      currentRound: 0, // 0 = not started, else 1..rounds
      finalized: false,
    },
    players: [], // {id, name, pool: "A"|"B"|"C"}
    cardsByRound: {}, // { "1":[{id,name,playerIds}], "2":[...] }
    scores: {}, // scores[round][station][playerId] = made(0..4)
    submitted: {}, // submitted[round][cardId] = true
  });

  // UI state
  const [setupOpen, setSetupOpen] = useState(true);
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);

  const [poolBoardsOpen, setPoolBoardsOpen] = useState({
    A: false,
    B: false,
    C: false,
  });

  // Add player UI
  const [name, setName] = useState("");
  const [pool, setPool] = useState("A");

  // Card creation UI (Round 1 admin)
  const [selectedForCard, setSelectedForCard] = useState([]); // playerIds
  const [cardName, setCardName] = useState("");

  // Scorekeeper selection UI
  const [activeCardId, setActiveCardId] = useState("");
  const [openStations, setOpenStations] = useState({}); // {stationNum: bool}

  // -------- Helpers (computed) --------
  const settings = putting.settings || {};
  const stations = Math.max(1, Math.min(36, Number(settings.stations || 9)));
  const totalRounds = Math.max(1, Math.min(5, Number(settings.rounds || 1)));
  const currentRound = Number(settings.currentRound || 0);
  const finalized = !!settings.finalized;

  const players = Array.isArray(putting.players) ? putting.players : [];
  const cardsByRound =
    putting.cardsByRound && typeof putting.cardsByRound === "object"
      ? putting.cardsByRound
      : {};
  const scores =
    putting.scores && typeof putting.scores === "object" ? putting.scores : {};
  const submitted =
    putting.submitted && typeof putting.submitted === "object"
      ? putting.submitted
      : {};

  const currentCards = Array.isArray(cardsByRound[String(currentRound)])
    ? cardsByRound[String(currentRound)]
    : [];

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  function madeFor(roundNum, stationNum, playerId) {
    const r = scores?.[String(roundNum)] || {};
    const st = r?.[String(stationNum)] || {};
    const val = st?.[playerId];
    return typeof val === "number" ? val : Number(val ?? 0) || 0;
  }

  function rawMadeExists(roundNum, stationNum, playerId) {
    const r = scores?.[String(roundNum)] || {};
    const st = r?.[String(stationNum)] || {};
    const raw = st?.[playerId];
    return raw !== undefined && raw !== null && raw !== "";
  }

  function roundTotalForPlayer(roundNum, playerId) {
    let total = 0;
    for (let s = 1; s <= stations; s++) {
      total += pointsForMade(madeFor(roundNum, s, playerId));
    }
    return total;
  }

  function cumulativeTotalForPlayer(playerId) {
    let total = 0;
    for (let r = 1; r <= totalRounds; r++) {
      total += roundTotalForPlayer(r, playerId);
    }
    return total;
  }

  function submittedCountForRound(roundNum) {
    const cards = Array.isArray(cardsByRound[String(roundNum)])
      ? cardsByRound[String(roundNum)]
      : [];
    const sub = submitted?.[String(roundNum)] || {};
    const count = cards.filter((c) => !!sub?.[c.id]).length;
    return { submitted: count, total: cards.length };
  }

  function allCardsSubmittedForRound(roundNum) {
    const { submitted: s, total: t } = submittedCountForRound(roundNum);
    return t > 0 && s === t;
  }

  // ✅ NEW: list the cards that have NOT submitted for a given round
  function missingCardsForRound(roundNum) {
    const cards = Array.isArray(cardsByRound[String(roundNum)])
      ? cardsByRound[String(roundNum)]
      : [];
    const sub = submitted?.[String(roundNum)] || {};
    return cards.filter((c) => !sub?.[c.id]);
  }

  function adminActionOrBlock(fn) {
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    return fn();
  }

  // -------- Firestore subscribe + bootstrap --------
  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const snap = await getDoc(leagueRef);
      if (!snap.exists()) {
        await setDoc(leagueRef, {
          players: [],
          rounds: [],
          roundHistory: [],
          defendMode: {
            enabled: false,
            scope: "podium",
            durationType: "weeks",
            weeks: 2,
            tagExpiresAt: {},
          },
          puttingLeague: {
            settings: {
              stations: 9,
              rounds: 1,
              locked: false,
              currentRound: 0,
              finalized: false,
            },
            players: [],
            cardsByRound: {},
            scores: {},
            submitted: {},
          },
        });
      }

      unsub = onSnapshot(leagueRef, (s) => {
        const data = s.data() || {};
        const pl = data.puttingLeague || {
          settings: {
            stations: 9,
            rounds: 1,
            locked: false,
            currentRound: 0,
            finalized: false,
          },
          players: [],
          cardsByRound: {},
          scores: {},
          submitted: {},
        };
        setPutting(pl);
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  // --------- Firestore update helpers ---------
  async function updatePutting(patch) {
    await updateDoc(leagueRef, {
      puttingLeague: {
        ...putting,
        ...patch,
      },
    });
  }

  async function updatePuttingDot(dotPath, value) {
    await updateDoc(leagueRef, {
      [`puttingLeague.${dotPath}`]: value,
    });
  }

  // --------- Admin actions: check-in / cards / rounds ---------
  async function addPlayer() {
    if (finalized) {
      alert("Scores are finalized. Reset to start a new league.");
      return;
    }

    const n = (name || "").trim();
    if (!n) return;

    const exists = players.some(
      (p) => (p.name || "").trim().toLowerCase() === n.toLowerCase()
    );
    if (exists) {
      alert("That name is already checked in.");
      return;
    }

    const newPlayer = { id: uid(), name: n, pool: pool || "A" };
    await updatePutting({ players: [...players, newPlayer] });

    setName("");
    setPool("A");
  }

  function toggleSelectForCard(playerId) {
    setSelectedForCard((prev) =>
      prev.includes(playerId)
        ? prev.filter((x) => x !== playerId)
        : [...prev, playerId]
    );
  }

  async function createCard() {
    if (finalized) return;

    if (!settings.locked) {
      alert("Begin Round 1 first (locks the format).");
      return;
    }
    if (currentRound !== 1) {
      alert("Cards can only be manually created for Round 1.");
      return;
    }

    if (selectedForCard.length < 2) {
      alert("Select at least 2 players for a card.");
      return;
    }
    if (selectedForCard.length > 4) {
      alert("Max 4 players per card.");
      return;
    }

    const cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
    const used = new Set();
    cards.forEach((c) => (c.playerIds || []).forEach((id) => used.add(id)));

    const overlaps = selectedForCard.some((id) => used.has(id));
    if (overlaps) {
      alert("One or more selected players are already assigned to a card.");
      return;
    }

    const newCard = {
      id: uid(),
      name: (cardName || "").trim() || `Card ${cards.length + 1}`,
      playerIds: selectedForCard,
    };

    await updatePuttingDot("cardsByRound.1", [...cards, newCard]);

    setSelectedForCard([]);
    setCardName("");
  }

  async function beginRoundOne() {
    if (finalized) return;

    await adminActionOrBlock(async () => {
      if (players.length < 2) {
        alert("Check in at least 2 players first.");
        return;
      }

      await updatePutting({
        settings: {
          ...settings,
          stations,
          rounds: totalRounds,
          locked: true,
          currentRound: 1,
          finalized: false,
        },
        cardsByRound: {
          ...(putting.cardsByRound || {}),
          "1": Array.isArray(putting.cardsByRound?.["1"])
            ? putting.cardsByRound["1"]
            : [],
        },
        submitted: {
          ...(putting.submitted || {}),
          "1": putting.submitted?.["1"] || {},
        },
      });

      setSetupOpen(false);
      setCheckinOpen(false);
      setCardsOpen(true);
    });
  }

  function buildAutoCardsFromRound(roundNum) {
    // Sort by prior round total desc, then chunk into 4s
    const ranked = [...players]
      .map((p) => ({
        id: p.id,
        total: roundTotalForPlayer(roundNum, p.id),
      }))
      .sort((a, b) => b.total - a.total);

    const cards = [];
    for (let i = 0; i < ranked.length; i += 4) {
      const chunk = ranked.slice(i, i + 4);
      cards.push({
        id: uid(),
        name: `Card ${cards.length + 1}`,
        playerIds: chunk.map((x) => x.id),
      });
    }
    return cards;
  }

  async function beginNextRound() {
    if (finalized) return;

    await adminActionOrBlock(async () => {
      if (!settings.locked || currentRound < 1) {
        alert("Round 1 has not begun yet.");
        return;
      }
      if (currentRound >= totalRounds) {
        alert("You are already on the final round.");
        return;
      }
      if (!allCardsSubmittedForRound(currentRound)) {
        const missing = missingCardsForRound(currentRound);
        const names = missing.map((c) => c.name).join(", ");
        alert(
          `Not all cards have submitted scores for Round ${currentRound} yet.\n\nWaiting on: ${names || "Unknown"}`
        );
        return;
      }

      const nextRound = currentRound + 1;

      // Auto-generate cards based on previous round totals
      const autoCards = buildAutoCardsFromRound(currentRound);

      await updatePutting({
        settings: { ...settings, currentRound: nextRound },
        cardsByRound: {
          ...(putting.cardsByRound || {}),
          [String(nextRound)]: autoCards,
        },
        submitted: {
          ...(putting.submitted || {}),
          [String(nextRound)]: {},
        },
      });

      setActiveCardId("");
      setOpenStations({});
      window.scrollTo(0, 0);
    });
  }

  async function finalizeScores() {
    await adminActionOrBlock(async () => {
      if (!settings.locked || currentRound < 1) {
        alert("League hasn't started yet.");
        return;
      }
      if (currentRound !== totalRounds) {
        alert("Finalize is only available on the final round.");
        return;
      }
      if (!allCardsSubmittedForRound(currentRound)) {
        const missing = missingCardsForRound(currentRound);
        const names = missing.map((c) => c.name).join(", ");
        alert(
          `Not all cards have submitted scores for the final round yet.\n\nWaiting on: ${names || "Unknown"}`
        );
        return;
      }

      await updatePutting({
        settings: { ...settings, finalized: true },
      });

      alert("Scores finalized. Leaderboards are now locked.");
    });
  }

  async function resetPuttingLeague() {
    await adminActionOrBlock(async () => {
      const ok = window.confirm(
        "Reset PUTTING league only?\n\nThis clears putting players, cards, scores, and settings.\n(Tag rounds will NOT be affected.)"
      );
      if (!ok) return;

      await updateDoc(leagueRef, {
        puttingLeague: {
          settings: {
            stations: 9,
            rounds: 1,
            locked: false,
            currentRound: 0,
            finalized: false,
          },
          players: [],
          cardsByRound: {},
          scores: {},
          submitted: {},
        },
      });

      setActiveCardId("");
      setOpenStations({});
      setSelectedForCard([]);
      setCardName("");
      setName("");
      setPool("A");
      setSetupOpen(true);
      setCheckinOpen(true);
      setCardsOpen(true);
    });
  }

  // -------- Scorekeeper actions --------
  function toggleStation(stationNum) {
    setOpenStations((prev) => ({
      ...prev,
      [stationNum]: !prev[stationNum],
    }));
  }

  async function setMade(roundNum, stationNum, playerId, made) {
    if (finalized) return;

    // Prevent editing older rounds once you move forward
    if (roundNum !== currentRound) {
      alert("This round is locked because the league has moved on.");
      return;
    }

    const val = clampMade(made);
    await updatePuttingDot(
      `scores.${String(roundNum)}.${String(stationNum)}.${playerId}`,
      val
    );
  }

  function isCardFullyFilled(roundNum, card) {
    const ids = card?.playerIds || [];
    if (!ids.length) return false;

    for (let s = 1; s <= stations; s++) {
      for (const pid of ids) {
        // 0 is valid, but undefined/missing is not
        if (!rawMadeExists(roundNum, s, pid)) return false;
      }
    }
    return true;
  }

  async function submitCardScores(cardId) {
    if (finalized) return;

    const card = currentCards.find((c) => c.id === cardId);
    if (!card) return;

    if (!isCardFullyFilled(currentRound, card)) {
      alert("This card is missing some scores. Fill all stations for all players.");
      return;
    }

    await updatePuttingDot(`submitted.${String(currentRound)}.${cardId}`, true);

    alert("Card submitted!");
  }

  // -------- Leaderboards (by pool, cumulative) --------
  const leaderboardByPool = useMemo(() => {
    const pools = { A: [], B: [], C: [] };

    players.forEach((p) => {
      const total = cumulativeTotalForPlayer(p.id);
      const row = { id: p.id, name: p.name, pool: p.pool, total };
      if (p.pool === "B") pools.B.push(row);
      else if (p.pool === "C") pools.C.push(row);
      else pools.A.push(row);
    });

    Object.keys(pools).forEach((k) => {
      pools[k].sort((a, b) => b.total - a.total);
    });

    return pools;
  }, [players, scores, stations, totalRounds]);

  // -------- UI: gating buttons --------
  const roundStarted = settings.locked && currentRound >= 1;

  const canBeginNextRound =
    roundStarted &&
    !finalized &&
    currentRound < totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const canFinalize =
    roundStarted &&
    !finalized &&
    currentRound === totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const submittedThisRound = submitted?.[String(currentRound)] || {};
  const submitStats = roundStarted
    ? submittedCountForRound(currentRound)
    : { submitted: 0, total: 0 };

  // ✅ NEW: missing cards list for the current round (for admin visibility)
  const missingCardsThisRound = roundStarted
    ? missingCardsForRound(currentRound)
    : [];

  // -------- Render --------
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
              marginBottom: 12,
              fontWeight: 900,
            }}
          >
            Putting League{" "}
            {roundStarted ? (
              <span style={{ color: COLORS.navy }}>
                — Round {currentRound} of {totalRounds}
              </span>
            ) : (
              <span style={{ opacity: 0.75, fontWeight: 800 }}>
                — Not started
              </span>
            )}
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* ✅ UPDATED Admin status line (shows who is holding things up) */}
          {roundStarted && (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 14 }}>
              <div>
                Admin Status: Cards submitted this round —{" "}
                <strong>
                  {submitStats.submitted} / {submitStats.total}
                </strong>
              </div>

              {missingCardsThisRound.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  Waiting on:{" "}
                  <strong style={{ color: COLORS.red }}>
                    {missingCardsThisRound.map((c) => c.name).join(", ")}
                  </strong>
                </div>
              ) : (
                <div style={{ marginTop: 6, color: COLORS.green, fontWeight: 900 }}>
                  All cards submitted ✅
                </div>
              )}
            </div>
          )}

          {/* ADMIN: Setup */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setSetupOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Admin Setup
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {setupOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {setupOpen && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                    Stations
                  </div>
                  <select
                    value={stations}
                    disabled={settings.locked || finalized}
                    onChange={(e) =>
                      updatePutting({
                        settings: {
                          ...settings,
                          stations: Number(e.target.value),
                        },
                      })
                    }
                    style={{ ...inputStyle, width: 120, background: "#fff" }}
                  >
                    {[6, 9, 12, 15, 18, 21].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>

                  <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                    Rounds
                  </div>
                  <select
                    value={totalRounds}
                    disabled={settings.locked || finalized}
                    onChange={(e) =>
                      updatePutting({
                        settings: {
                          ...settings,
                          rounds: Number(e.target.value),
                        },
                      })
                    }
                    style={{ ...inputStyle, width: 120, background: "#fff" }}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>

                  {!roundStarted ? (
                    <button
                      onClick={beginRoundOne}
                      style={{
                        ...smallButtonStyle,
                        background: COLORS.green,
                        color: "white",
                        border: `1px solid ${COLORS.green}`,
                      }}
                      disabled={finalized}
                      title="Locks stations/rounds and begins Round 1"
                    >
                      Begin Round 1 (Lock Format)
                    </button>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Format locked.
                    </div>
                  )}
                </div>

                {canBeginNextRound && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      onClick={beginNextRound}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.navy,
                        color: "white",
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      title="Only appears after every card submits for the current round"
                    >
                      Begin Next Round (Auto Cards)
                    </button>
                  </div>
                )}

                {canFinalize && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      onClick={finalizeScores}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.red,
                        color: "white",
                        border: `1px solid ${COLORS.red}`,
                      }}
                      title="Only appears after every card submits for the final round"
                    >
                      Finalize Scores (Lock)
                    </button>
                  </div>
                )}

                <div style={{ marginTop: 12 }}>
                  <button
                    onClick={resetPuttingLeague}
                    style={{
                      ...smallButtonStyle,
                      width: "100%",
                      background: "#fff",
                      border: `1px solid ${COLORS.border}`,
                    }}
                  >
                    Reset Putting League (Admin)
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ADMIN: Check-in */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setCheckinOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Player Check-In ({players.length})
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {checkinOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {checkinOpen && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    placeholder="Player name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ ...inputStyle, width: 240 }}
                    disabled={finalized}
                  />
                  <select
                    value={pool}
                    onChange={(e) => setPool(e.target.value)}
                    style={{ ...inputStyle, width: 140, background: "#fff" }}
                    disabled={finalized}
                  >
                    <option value="A">A Pool</option>
                    <option value="B">B Pool</option>
                    <option value="C">C Pool</option>
                  </select>
                  <button
                    onClick={addPlayer}
                    style={{
                      ...smallButtonStyle,
                      background: COLORS.green,
                      color: "white",
                      border: `1px solid ${COLORS.green}`,
                    }}
                    disabled={finalized}
                  >
                    Add
                  </button>
                </div>

                {players.length ? (
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    {players.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: `1px solid ${COLORS.border}`,
                          background: "#fff",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div style={{ fontWeight: 900, color: COLORS.text }}>
                          {p.name}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                          {p.pool === "B"
                            ? "B Pool"
                            : p.pool === "C"
                            ? "C Pool"
                            : "A Pool"}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                    Add players as they arrive.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ADMIN: Cards */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setCardsOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Cards — Round {currentRound || 1}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {cardsOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {cardsOpen && (
              <div style={{ marginTop: 10 }}>
                {roundStarted && currentRound === 1 ? (
                  <>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                      Create Round 1 cards (up to 4 players each). Pools can be mixed.
                    </div>

                    <div
                      style={{
                        border: `1px solid ${COLORS.border}`,
                        background: "#fff",
                        borderRadius: 12,
                        padding: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          flexWrap: "wrap",
                          alignItems: "center",
                          marginBottom: 10,
                        }}
                      >
                        <input
                          placeholder="Card name (optional)"
                          value={cardName}
                          onChange={(e) => setCardName(e.target.value)}
                          style={{ ...inputStyle, width: 240 }}
                          disabled={finalized}
                        />
                        <button
                          onClick={createCard}
                          style={{
                            ...smallButtonStyle,
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                          }}
                          disabled={finalized}
                        >
                          Create Card
                        </button>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Selected: <strong>{selectedForCard.length}</strong> / 4
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 8 }}>
                        {players.map((p) => {
                          const isSelected = selectedForCard.includes(p.id);

                          const r1Cards = Array.isArray(cardsByRound["1"])
                            ? cardsByRound["1"]
                            : [];
                          const already = r1Cards.some((c) =>
                            (c.playerIds || []).includes(p.id)
                          );

                          return (
                            <label
                              key={p.id}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 10,
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: `1px solid ${COLORS.border}`,
                                background: already ? "#fafafa" : COLORS.soft,
                                opacity: already ? 0.6 : 1,
                                cursor: already ? "not-allowed" : "pointer",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={already || finalized}
                                  onChange={() => toggleSelectForCard(p.id)}
                                />
                                <div style={{ fontWeight: 900 }}>
                                  {p.name}
                                </div>
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                                {p.pool === "B"
                                  ? "B Pool"
                                  : p.pool === "C"
                                  ? "C Pool"
                                  : "A Pool"}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : roundStarted && currentRound >= 2 ? (
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                    Cards for Round {currentRound} are auto-created based on Round{" "}
                    {currentRound - 1} totals (highest grouped together).
                  </div>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
                    Begin Round 1 to create cards.
                  </div>
                )}

                <div style={{ display: "grid", gap: 8 }}>
                  {(Array.isArray(cardsByRound[String(currentRound || 1)])
                    ? cardsByRound[String(currentRound || 1)]
                    : []
                  ).map((c) => (
                    <div
                      key={c.id}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: `1px solid ${COLORS.border}`,
                        background: "#fff",
                      }}
                    >
                      <div style={{ fontWeight: 900, color: COLORS.navy }}>
                        {c.name}
                        {roundStarted && currentRound ? (
                          <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.75 }}>
                            {submitted?.[String(currentRound)]?.[c.id]
                              ? "✓ submitted"
                              : "not submitted"}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 14 }}>
                        {(c.playerIds || []).map((pid) => {
                          const p = playerById[pid];
                          if (!p) return null;
                          return (
                            <div
                              key={pid}
                              style={{ display: "flex", justifyContent: "space-between" }}
                            >
                              <span style={{ fontWeight: 800 }}>{p.name}</span>
                              <span style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                                {p.pool === "B"
                                  ? "B Pool"
                                  : p.pool === "C"
                                  ? "C Pool"
                                  : "A Pool"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* SCOREKEEPER: Choose your card */}
          {roundStarted ? (
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                borderRadius: 14,
                background: "#fff",
                padding: 12,
                textAlign: "left",
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 8 }}>
                Scorekeeper
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={activeCardId}
                  onChange={(e) => {
                    setActiveCardId(e.target.value);
                    setOpenStations({});
                  }}
                  style={{ ...inputStyle, width: 280, background: "#fff" }}
                >
                  <option value="">Select your card…</option>
                  {currentCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>

                {activeCardId ? (
                  <button
                    onClick={() => {
                      setActiveCardId("");
                      setOpenStations({});
                    }}
                    style={{ ...smallButtonStyle, background: "#fff" }}
                  >
                    Change Card
                  </button>
                ) : null}
              </div>

              {activeCardId ? (
                (() => {
                  const card = currentCards.find((c) => c.id === activeCardId);
                  if (!card) return null;

                  const cardPlayers = (card.playerIds || [])
                    .map((pid) => playerById[pid])
                    .filter(Boolean);

                  const alreadySubmitted = !!submittedThisRound?.[card.id];

                  return (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 10 }}>
                        {card.name}{" "}
                        {alreadySubmitted ? (
                          <span style={{ color: COLORS.green, marginLeft: 8 }}>(submitted)</span>
                        ) : (
                          <span style={{ opacity: 0.6, marginLeft: 8 }}>(in progress)</span>
                        )}
                      </div>

                      {/* Stations accordion */}
                      <div style={{ display: "grid", gap: 10 }}>
                        {Array.from({ length: stations }, (_, i) => i + 1).map((stNum) => {
                          const open = !!openStations[stNum];

                          const stationRows = cardPlayers.map((p) => {
                            const made = madeFor(currentRound, stNum, p.id);
                            return {
                              id: p.id,
                              name: p.name,
                              pool: p.pool,
                              made,
                              pts: pointsForMade(made),
                            };
                          });

                          return (
                            <div
                              key={stNum}
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 14,
                                background: COLORS.soft,
                                overflow: "hidden",
                              }}
                            >
                              <div
                                onClick={() => toggleStation(stNum)}
                                style={{
                                  padding: "12px 12px",
                                  cursor: "pointer",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div style={{ fontWeight: 900, color: COLORS.navy }}>
                                  Station {stNum}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.75 }}>
                                  {open ? "Tap to collapse" : "Tap to expand"}
                                </div>
                              </div>

                              {open && (
                                <div style={{ padding: 12, background: "#fff" }}>
                                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
                                    Enter <strong>made putts (0–4)</strong> for each player.
                                    (4=5pts, 3=3pts, 2=2pts, 1=1pt, 0=0)
                                  </div>

                                  <div style={{ display: "grid", gap: 8 }}>
                                    {stationRows.map((row) => (
                                      <div
                                        key={row.id}
                                        style={{
                                          display: "flex",
                                          justifyContent: "space-between",
                                          alignItems: "center",
                                          gap: 10,
                                          padding: "10px 12px",
                                          borderRadius: 12,
                                          border: `1px solid ${COLORS.border}`,
                                          background: COLORS.soft,
                                        }}
                                      >
                                        <div style={{ flex: 1 }}>
                                          <div style={{ fontWeight: 900, color: COLORS.text }}>
                                            {row.name}{" "}
                                            <span style={{ fontSize: 12, opacity: 0.75 }}>
                                              (
                                              {row.pool === "B"
                                                ? "B Pool"
                                                : row.pool === "C"
                                                ? "C Pool"
                                                : "A Pool"}
                                              )
                                            </span>
                                          </div>
                                        </div>

                                        <select
                                          value={clampMade(row.made)}
                                          disabled={alreadySubmitted || finalized}
                                          onChange={(e) =>
                                            setMade(
                                              currentRound,
                                              stNum,
                                              row.id,
                                              Number(e.target.value)
                                            )
                                          }
                                          style={{
                                            ...inputStyle,
                                            width: 90,
                                            background: "#fff",
                                            fontWeight: 900,
                                            textAlign: "center",
                                          }}
                                        >
                                          {[0, 1, 2, 3, 4].map((m) => (
                                            <option key={m} value={m}>
                                              {m} made
                                            </option>
                                          ))}
                                        </select>

                                        <div
                                          style={{
                                            width: 90,
                                            textAlign: "right",
                                            fontWeight: 900,
                                            color: COLORS.navy,
                                          }}
                                        >
                                          {row.pts} pts
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Round totals summary (for this card) */}
                      <div style={{ marginTop: 14 }}>
                        <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 8 }}>
                          Round {currentRound} Totals (This Card)
                        </div>

                        <div style={{ display: "grid", gap: 8 }}>
                          {cardPlayers.map((p) => {
                            const total = roundTotalForPlayer(currentRound, p.id);
                            return (
                              <div
                                key={p.id}
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: 12,
                                  border: `1px solid ${COLORS.border}`,
                                  background: "#fff",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div style={{ fontWeight: 900 }}>
                                  {p.name}{" "}
                                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                                    (
                                    {p.pool === "B"
                                      ? "B Pool"
                                      : p.pool === "C"
                                      ? "C Pool"
                                      : "A Pool"}
                                    )
                                  </span>
                                </div>
                                <div style={{ fontWeight: 900, color: COLORS.navy }}>
                                  {total} pts
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <button
                          onClick={() => submitCardScores(card.id)}
                          disabled={alreadySubmitted || finalized}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: alreadySubmitted ? "#ddd" : COLORS.green,
                            color: alreadySubmitted ? "#444" : "white",
                            border: `1px solid ${alreadySubmitted ? "#ddd" : COLORS.green}`,
                          }}
                          title="Only works when every station has scores for every player"
                        >
                          {alreadySubmitted ? "Card Submitted" : "Submit Card Scores"}
                        </button>

                        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75, textAlign: "center" }}>
                          Submitting is required before the admin can begin the next round or finalize.
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  Select your card to start scoring. You’ll only see your card.
                </div>
              )}
            </div>
          ) : null}

          {/* LEADERBOARDS by pool (collapsible) */}
          <div style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 8 }}>
              Leaderboards (Cumulative)
            </div>

            {["A", "B", "C"].map((k) => {
              const label = k === "A" ? "A Pool" : k === "B" ? "B Pool" : "C Pool";
              const open = !!poolBoardsOpen[k];
              const rows = leaderboardByPool[k] || [];

              return (
                <div
                  key={k}
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 14,
                    background: "#fff",
                    marginBottom: 10,
                    overflow: "hidden",
                  }}
                >
                  <div
                    onClick={() =>
                      setPoolBoardsOpen((prev) => ({ ...prev, [k]: !prev[k] }))
                    }
                    style={{
                      padding: "12px 12px",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      background: COLORS.soft,
                    }}
                  >
                    <div style={{ fontWeight: 900, color: COLORS.navy }}>
                      {label}{" "}
                      <span style={{ fontSize: 12, opacity: 0.75 }}>
                        ({rows.length})
                      </span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      {open ? "Tap to collapse" : "Tap to expand"}
                    </div>
                  </div>

                  {open && (
                    <div style={{ padding: 12 }}>
                      {rows.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          No players in this pool yet.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: 8 }}>
                          {rows.map((r, idx) => (
                            <div
                              key={r.id}
                              style={{
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: `1px solid ${COLORS.border}`,
                                background: COLORS.soft,
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                <div
                                  style={{
                                    width: 34,
                                    textAlign: "center",
                                    fontWeight: 900,
                                    color: COLORS.navy,
                                  }}
                                >
                                  {idx + 1}
                                </div>
                                <div style={{ fontWeight: 900, color: COLORS.text }}>
                                  {r.name}
                                </div>
                              </div>

                              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                                {r.total} pts
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div style={{ marginTop: 14, textAlign: "center", fontSize: 12, color: "#666" }}>
            Putting League • Version 1.2 • Developed by Eli Morgan
          </div>
        </div>
      </div>
    </div>
  );
}
