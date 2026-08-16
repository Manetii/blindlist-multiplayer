/**
 * ════════════════════════════════════════════════════════════════
 *  SCORING — calcul des points d'une manche
 * ════════════════════════════════════════════════════════════════
 *
 *  Trois règles, chacune produisant des événements motivés plutôt
 *  qu'un total. C'est ce qui permet d'afficher « pourquoi 3 points ? »
 *  et de tracer les ajustements de l'hôte comme tels.
 *
 *    R1 TROUVEUR  (toujours actif)
 *       +1 à chaque joueur ayant désigné le bon proposant.
 *
 *    R2 BLUFFEUR  (toujours actif)
 *       +1 au joueur désigné à tort, par vote erroné reçu. Son goût
 *       musical a été jugé compatible avec un morceau qui n'est pas
 *       le sien — c'est ce qui récompense un profil difficile à cerner.
 *
 *    R3 PIÉGEUR   (optionnel, réglage de la soirée)
 *       +1 au proposant si PERSONNE ne l'a trouvé. Récompense un
 *       morceau hors de son registre apparent.
 *
 *  Le calcul est fait ICI, côté hôte, et poussé au serveur en batch.
 *  Le serveur ne fait qu'écrire : il n'a pas à connaître les règles,
 *  ce qui permet de les faire évoluer sans migration ni redéploiement
 *  du protocole.
 *
 *  Aucun plancher à zéro : un ajustement manuel de −1 doit pouvoir
 *  faire descendre un score sous zéro si l'hôte le décide.
 * ════════════════════════════════════════════════════════════════
 */

window.Scoring = (() => {
  'use strict';

  const LABELS = {
    finder:  'a trouvé',
    bluffer: 'a bluffé',
    trapper: 'a piégé tout le monde',
    manual:  'ajustement',
  };

  /**
   * @param {Array} votes      [{ voterId, votedId, voter, voted }]
   * @param {string} ownerId   participantId du proposant
   * @param {object} opts      { blufferRule, trapperRule }
   * @returns {{events:Array, byPlayer:Map}}
   */
  function compute(votes, ownerId, opts = {}) {
    const events = [];
    let finders = 0;

    for (const v of votes) {
      if (v.votedId === ownerId) {
        // R1 — le votant a trouvé.
        events.push({ participantId: v.voterId, points: 1, reason: 'finder' });
        finders++;
      } else if (opts.blufferRule !== false) {
        // R2 — le joueur désigné à tort encaisse. Le proposant lui-même
        // est exclu : recevoir un vote erroné alors qu'on est la bonne
        // réponse n'a pas de sens.
        if (v.votedId && v.votedId !== ownerId) {
          events.push({ participantId: v.votedId, points: 1, reason: 'bluffer' });
        }
      }
    }

    // R3 — personne n'a trouvé. Ne s'applique que s'il y a eu des votes :
    // une manche sans participant ne « piège » personne.
    if (opts.trapperRule && votes.length > 0 && finders === 0 && ownerId) {
      events.push({ participantId: ownerId, points: 1, reason: 'trapper' });
    }

    return { events, byPlayer: group(events) };
  }

  /** Regroupe les événements par joueur, pour l'affichage. */
  function group(events) {
    const map = new Map();
    for (const e of events) {
      if (!map.has(e.participantId)) map.set(e.participantId, { total: 0, reasons: [] });
      const entry = map.get(e.participantId);
      entry.total += e.points;
      entry.reasons.push(e.reason);
    }
    return map;
  }

  /**
   * Résumé lisible des raisons d'un joueur.
   * « a trouvé, a bluffé ×2 »
   */
  function explain(reasons) {
    const counts = new Map();
    for (const r of reasons) counts.set(r, (counts.get(r) || 0) + 1);
    return [...counts.entries()]
      .map(([r, n]) => LABELS[r] + (n > 1 ? ` ×${n}` : ''))
      .join(', ');
  }

  /**
   * Fusionne les ajustements manuels de l'hôte dans les événements.
   * @param {Array} base                 événements calculés
   * @param {Map<string,number>} deltas  participantId → ±n
   */
  function withAdjustments(base, deltas) {
    const out = base.slice();
    for (const [participantId, n] of deltas) {
      if (!n) continue;
      out.push({ participantId, points: n, reason: 'manual' });
    }
    return out;
  }

  return { compute, group, explain, withAdjustments, LABELS };
})();
