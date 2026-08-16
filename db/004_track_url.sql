-- ════════════════════════════════════════════════════════════════
--  004 — URL du morceau
-- ════════════════════════════════════════════════════════════════
--
--  Le manifeste donne titre, artiste et durée : assez pour chercher,
--  pas pour être certain de tomber sur la bonne version. L'URL renvoyée
--  par la source de recherche lève l'ambiguïté — on ouvre la page, on
--  écoute l'extrait, on récupère exactement ce morceau-là.
--
--  Nullable : les sources ne fournissent pas toutes une URL publique,
--  et les morceaux déjà saisis n'en ont pas.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE tracks ADD COLUMN url text;

-- Le manifeste porte désormais l'URL, et n'impose plus de nom de
-- fichier : l'appariement se fait sur les métadonnées. Le nom canonique
-- reste calculé, à titre de suggestion pour qui veut nommer ses
-- fichiers proprement.
DROP VIEW IF EXISTS v_acquisition_manifest;

CREATE VIEW v_acquisition_manifest AS
SELECT
  t.party_id,
  t.acquisition_no,
  lpad(t.acquisition_no::text, 3, '0') || '__' ||
    regexp_replace(t.artist, '[^A-Za-z0-9]+', '_', 'g') || '__' ||
    regexp_replace(t.title,  '[^A-Za-z0-9]+', '_', 'g') || '.mp3'
                       AS expected_file_name,
  t.artist, t.title, t.album, t.duration_ms,
  t.source, t.source_id, t.url,
  pa.display_name      AS proposed_by,
  t.state
FROM tracks t
JOIN participants pa ON pa.id = t.participant_id
WHERE t.acquisition_no IS NOT NULL
ORDER BY t.acquisition_no;
