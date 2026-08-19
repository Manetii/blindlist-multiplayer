-- ════════════════════════════════════════════════════════════════
--  007 — L'auto-inscription devient la règle
-- ════════════════════════════════════════════════════════════════
--
--  L'hôte ne saisit plus les pseudos : la console ne propose plus de
--  les créer, et l'écran d'arrivée gère déjà les homonymes (409 avec
--  suggestions). Demander à l'hôte de deviner l'orthographe exacte des
--  prénoms de ses invités faisait double emploi avec le geste que les
--  invités posent eux-mêmes.
--
--  Le défaut `false` devenait donc un piège : plus aucune interface ne
--  permettait de le passer à `true`, et une soirée créée avant ce
--  changement restait définitivement fermée — le joueur voyait « l'hôte
--  n'a encore ajouté personne » sans aucun moyen d'en sortir.
--
--  La colonne est conservée : fermer les inscriptions reste une action
--  légitime, et le verrouillage de la collecte s'en servira.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE parties
  ALTER COLUMN allow_self_registration SET DEFAULT true;

-- Les soirées déjà créées : celles qui n'ont pas commencé à jouer
-- doivent pouvoir accueillir du monde.
UPDATE parties
   SET allow_self_registration = true
 WHERE state IN ('collecte', 'verrouillee', 'prete');
