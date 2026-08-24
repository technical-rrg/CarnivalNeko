const fs = require('fs');
const path = 'd:/CocosProject/CarnivalNeko/assets/bundle/Base.prefab';
const a = JSON.parse(fs.readFileSync(path, 'utf8'));

const gameRoot = a[2];
if (!gameRoot || gameRoot._name !== 'GameRoot') {
    console.error('GameRoot not at index 2', gameRoot?._name);
    process.exit(1);
}

const before = gameRoot._children.map((c) => a[c.__id__]?._name);
gameRoot._children = gameRoot._children.filter((c) => {
    const n = a[c.__id__];
    return n && n._name !== 'BackgroundSpine' && n._name !== 'BackgroundSpine_FadeTwin';
});
const after = gameRoot._children.map((c) => a[c.__id__]?._name);
console.log('children before', before);
console.log('children after', after);

function stripNode(id) {
    const node = a[id];
    if (!node) return;
    node._parent = null;
    node._active = false;
    // Remove Widget from components list
    if (Array.isArray(node._components)) {
        node._components = node._components.filter((c) => {
            const comp = a[c.__id__];
            return comp && comp.__type__ !== 'cc.Widget';
        });
    }
}

// Find spine nodes by name
a.forEach((o, i) => {
    if (o && (o._name === 'BackgroundSpine' || o._name === 'BackgroundSpine_FadeTwin')) {
        console.log('strip', i, o._name, 'comps before', o._components);
        stripNode(i);
        console.log('comps after', o._components);
    }
});

fs.writeFileSync(path, JSON.stringify(a));
console.log('done, GameRoot child count', gameRoot._children.length);
