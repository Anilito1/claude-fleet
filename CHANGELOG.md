# Changelog

## 0.1.0

Première version.

- Vue latérale + plein écran avec bulles flottantes hiérarchiques (session → sous-agents).
- Lecture incrémentale des transcripts `~/.claude/projects/**` (sessions + `subagents/agent-*`).
- Tokens et coût $ API en direct, tarifs configurables par famille de modèle.
- Statuts en direct / inactif / terminé, connecteurs SVG animés.
- Panneau détail : décomposition coût/tokens, contexte, flux des derniers événements.
- Contrôles : nouvelle session, reprendre la main (`claude --resume`), copier resume, ouvrir transcript, révéler.
- Filtre « ce projet » / « tous ».
