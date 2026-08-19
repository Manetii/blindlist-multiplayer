-- ════════════════════════════════════════════════════════════════
--  009 — Les décomptes de progression rendus en entiers
-- ════════════════════════════════════════════════════════════════
--
--  count() produit un bigint, que le pilote JavaScript rend en CHAÎNE :
--  un bigint peut dépasser Number.MAX_SAFE_INTEGER, et node-postgres
--  refuse à juste titre de deviner. Sauf qu'ici la valeur est le nombre
--  de morceaux d'une personne.
--
--  Le symptôme était silencieux et absurde : additionner ces valeurs
--  concaténait au lieu de sommer — trois participants ayant 0, 3 et 1
--  morceaux donnaient « 031 ». Pire, la comparaison à 0 ne pouvait plus
--  être vraie, ce qui masquait définitivement le bouton de changement
--  de mode.
--
--  Le cast rend le contrat explicite là où il est écrit, plutôt que de
--  demander à chaque appelant de se souvenir de convertir.
-- ════════════════════════════════════════════════════════════════

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
  (pa.submitted_at IS NOT NULL)                                   AS submitted,
  (count(t.id) FILTER (WHERE t.state <> 'excluded'))::int          AS tracks_submitted,
  p.min_tracks_per_person,
  p.max_tracks_per_person,
  count(t.id) FILTER (WHERE t.state <> 'excluded')
    >= p.min_tracks_per_person                                    AS meets_minimum,
  (count(t.id) FILTER (WHERE t.state = 'verified'))::int          AS tracks_verified,
  pa.last_seen_at
FROM parties p
JOIN participants pa ON pa.party_id = p.id
LEFT JOIN tracks  t  ON t.participant_id = pa.id
GROUP BY p.id, pa.id;
