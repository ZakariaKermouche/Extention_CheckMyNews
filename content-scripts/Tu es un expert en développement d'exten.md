Tu es un expert en développement d'extensions Chrome (Manifest V3) et en reverse engineering d'applications React/GraphQL.

Je travaille sur une extension Chrome qui scrape le feed Facebook pendant que l'utilisateur scroll. 
Mon extension fonctionne PARTIELLEMENT :
- ✅ Elle capture correctement les posts du chargement initial (bootstrap)
- ❌ En scrollant, elle ne récupère que le début du texte des nouveaux posts ("voir plus..."), sans les données complètes

## CONTEXTE TECHNIQUE FACEBOOK
- Facebook est une SPA React avec infinite scroll
- Les posts du bootstrap arrivent via le HTML initial ou une première requête GraphQL
- Les posts chargés au scroll arrivent via des requêtes POST vers https://www.facebook.com/api/graphql/
- Ces requêtes de pagination utilisent des doc_id spécifiques (ex: NewsFeedTopStoriesPaginationQuery)
- Les réponses sont en JSON multi-lignes (un objet JSON par ligne, pas un tableau)
- Les class CSS sont obfusquées et changent, donc on ne cible jamais par className
- Les données utiles sont dans : data.node, data.viewer.newsFeedConnection.edges, ou data.nodes

## PROBLÈME PRÉCIS À RÉSOUDRE
Le fetch hook ou le MutationObserver ne capture pas correctement les réponses GraphQL de pagination (scroll).
Il faut intercepter les requêtes fetch/XHR sortantes vers /api/graphql/ et lire leur réponse complète,
puis extraire les mêmes champs que le bootstrap pour les posts chargés dynamiquement.

## VARIABLES À ENVOYER AU BACKEND (NE PAS CHANGER)
Garde exactement ces noms de variables dans la logique d'extraction des posts

## CE QUE TU DOIS FAIRE
1. Analyser mon code existant que je vais te fournir
2. Identifier pourquoi la pagination scroll ne fonctionne pas
3. Proposer la correction minimale et ciblée, sans réécrire ce qui fonctionne déjà
4. Ajouter l'interception robuste des réponses GraphQL de pagination avec :
   - Un hook sur window.fetch() injecté dans world: MAIN (pas l'isolated world)
   - Un fallback sur XMLHttpRequest si nécessaire
   - Un parsing défensif du JSON multi-lignes (split('\n') + try/catch par ligne)
   - Une déduplication par post_id pour éviter les doublons entre bootstrap et scroll
5. Garder exactement la même structure d'objet envoyée au backend

## CONTRAINTES
- Manifest V3 uniquement
- Ne pas modifier la logique d'envoi vers le backend
- Ne pas casser ce qui fonctionne (bootstrap)
- Parsing défensif partout (?. sur chaque niveau du JSON)
- Ne jamais cibler par className CSS (obfusqué par Facebook)
- Cibler uniquement par : data-*, role, aria-*, href patterns, ou structure GraphQL JSON

## FORMAT DE RÉPONSE ATTENDU
1. Diagnostic : ce qui cause le problème dans mon code
2. Code corrigé : uniquement les fichiers/fonctions modifiés
3. Explication : pourquoi ça résout le problème