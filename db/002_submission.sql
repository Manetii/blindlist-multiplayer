-- ════════════════════════════════════════════════════════════════
--  002 — Validation de la sélection
-- ════════════════════════════════════════════════════════════════
--
--  Jusqu'ici, un panier était « fini » quand l'hôte décidait de
--  verrouiller. Le participant n'avait aucun moyen de dire « voilà,
--  j'ai terminé » — et l'hôte aucun moyen de distinguer une personne
--  qui a fini avec trois morceaux d'une personne qui en est à trois
--  et compte revenir.
--
--  submitted_at rend cet engagement explicite, et réversible : tant
--  que la collecte est ouverte, on peut dévalider pour modifier.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE participants
  ADD COLUMN submitted_at timestamptz;

-- Retrouver rapidement qui n'a pas encore validé, pour les relances.
CREATE INDEX participants_pending_idx
  ON participants (party_id) WHERE submitted_at IS NULL;

-- La vue de complétion expose l'état de validation à côté du décompte :
-- l'hôte doit pouvoir distinguer « pas assez de morceaux » de « pas
-- encore validé », qui appellent des relances différentes.
DROP VIEW IF EXISTS v_party_progress;

CREATE VIEW v_party_progress AS
SELECT
  p.id                AS party_id,
  p.code,
  p.state,
  pa.id               AS participant_id,
  pa.display_name,
  pa.is_managed,
  pa.submitted_at,
  (pa.submitted_at IS NOT NULL)                              AS submitted,
  count(t.id) FILTER (WHERE t.state <> 'excluded')           AS tracks_submitted,
  p.min_tracks_per_person,
  p.max_tracks_per_person,
  count(t.id) FILTER (WHERE t.state <> 'excluded')
    >= p.min_tracks_per_person                               AS meets_minimum,
  count(t.id) FILTER (WHERE t.state = 'verified')            AS tracks_verified,
  pa.last_seen_at
FROM parties p
JOIN participants pa ON pa.party_id = p.id
LEFT JOIN tracks  t  ON t.participant_id = pa.id
GROUP BY p.id, pa.id;
