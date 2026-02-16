const colors = [
    'Red', 'Blue', 'Green', 'Purple', 'Orange',
    'Silver', 'Golden', 'Crimson', 'Jade', 'Coral',
    'Amber', 'Violet', 'Indigo', 'Teal', 'Rose'
];

const animals = [
    'Dolphin', 'Eagle', 'Tiger', 'Panda', 'Fox',
    'Whale', 'Wolf', 'Falcon', 'Lynx', 'Otter',
    'Raven', 'Phoenix', 'Dragon', 'Hawk', 'Bear'
];

function generateAnonymousId(existingIds = []) {
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
        const color = colors[Math.floor(Math.random() * colors.length)];
        const animal = animals[Math.floor(Math.random() * animals.length)];
        const id = `${color} ${animal}`;
        if (!existingIds.includes(id)) return id;
    }
    // Fallback: add a number suffix
    const color = colors[Math.floor(Math.random() * colors.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return `${color} ${animal} ${Math.floor(Math.random() * 99)}`;
}

function getColorForIdentity(identity) {
    const colorMap = {
        'Red': '#ef4444', 'Blue': '#3b82f6', 'Green': '#22c55e',
        'Purple': '#a855f7', 'Orange': '#f97316', 'Silver': '#94a3b8',
        'Golden': '#eab308', 'Crimson': '#dc2626', 'Jade': '#10b981',
        'Coral': '#fb7185', 'Amber': '#f59e0b', 'Violet': '#8b5cf6',
        'Indigo': '#6366f1', 'Teal': '#14b8a6', 'Rose': '#f43f5e'
    };
    const colorName = identity.split(' ')[0];
    return colorMap[colorName] || '#22c55e';
}

module.exports = { generateAnonymousId, getColorForIdentity };
