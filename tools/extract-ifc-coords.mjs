#!/usr/bin/env node
/**
 * Извлечение координат и origins из IFC файла
 * Использование: node extract-ifc-coords.mjs file.ifc
 */

import fs from 'fs';
import path from 'path';

const file = process.argv[2];
if (!file) {
    console.error('Использование: node extract-ifc-coords.mjs <file.ifc>');
    process.exit(1);
}

if (!fs.existsSync(file)) {
    console.error(`Файл не найден: ${file}`);
    process.exit(1);
}

const content = fs.readFileSync(file, 'utf8');

// Парсим IFC по строкам
const lines = content.split('\n');
const entities = {};

// Простой парсер IFC: ищем #123 = ENTITY_NAME(...);
const entityRegex = /#(\d+)\s*=\s*([A-Z_]+)\s*\((.*?)\)\s*;/gs;
let match;

while ((match = entityRegex.exec(content)) !== null) {
    const id = match[1];
    const type = match[2];
    const params = match[3];
    entities[id] = { type, params, raw: match[0] };
}

console.log(`\n📄 Файл: ${path.basename(file)}`);
console.log(`📊 Найдено сущностей: ${Object.keys(entities).length}\n`);

// Ищем Project
const projectId = Object.entries(entities).find(([_, e]) => e.type === 'IFCPROJECT')?.[0];
if (projectId) {
    console.log(`✓ IfcProject: #${projectId}`);
    console.log(`  ${entities[projectId].raw.substring(0, 100)}...\n`);
}

// Ищем Site
const siteId = Object.entries(entities).find(([_, e]) => e.type === 'IFCSITE')?.[0];
if (siteId) {
    console.log(`✓ IfcSite: #${siteId}`);
    const siteParams = entities[siteId].params;
    console.log(`  ${siteParams.substring(0, 150)}...\n`);
}

// Ищем Building
const buildingId = Object.entries(entities).find(([_, e]) => e.type === 'IFCBUILDING')?.[0];
if (buildingId) {
    console.log(`✓ IfcBuilding: #${buildingId}`);
    console.log(`  ${entities[buildingId].raw.substring(0, 100)}...\n`);
}

// Ищем LocalPlacement и Axis2Placement3D (содержат Location)
console.log('🔍 Поиск Placement и Location...\n');

Object.entries(entities).forEach(([id, entity]) => {
    if (entity.type === 'IFCLOCALPLACEMENT' || entity.type === 'IFCAXIS2PLACEMENT3D') {
        console.log(`✓ ${entity.type}: #${id}`);
        console.log(`  ${entity.raw.substring(0, 150)}...\n`);
    }
});

// Ищем CartesianPoint с большими координатами (geo)
console.log('📍 CartesianPoint (потенциальные geo-координаты):\n');

Object.entries(entities)
    .filter(([_, e]) => e.type === 'IFCCARTESIANPOINT')
    .slice(0, 20) // Первые 20
    .forEach(([id, entity]) => {
        const coords = entity.params.match(/[\d\-\.]+/g);
        if (coords && coords.length >= 2) {
            const nums = coords.map(Number);
            // Выделяем большие координаты (>1000 м - признак georef)
            const isGeo = nums.some(n => Math.abs(n) > 1000);
            if (isGeo) {
                console.log(`✓ #${id} [GEO]: (${nums.join(', ')})`);
            }
        }
    });

// Ищем MapConversion (для geo-привязки)
console.log('\n🌍 Geo-привязка:\n');
Object.entries(entities).forEach(([id, entity]) => {
    if (entity.type === 'IFCMAPCONVERSION') {
        console.log(`✓ IfcMapConversion: #${id}`);
        console.log(`  ${entity.raw.substring(0, 200)}...\n`);
    }
    if (entity.type === 'IFCPROJECTEDCRS' || entity.type === 'IFCGEOMETRICREPRESENTATIONCONTEXT') {
        console.log(`✓ ${entity.type}: #${id}`);
        console.log(`  ${entity.params.substring(0, 100)}...\n`);
    }
});

// Вывод всех CartesianPoint для анализа
console.log('\n📋 ВСЕ CartesianPoint (для анализа):\n');
Object.entries(entities)
    .filter(([_, e]) => e.type === 'IFCCARTESIANPOINT')
    .forEach(([id, entity]) => {
        const coords = entity.params.match(/[\d\-\.]+/g);
        if (coords) {
            const nums = coords.slice(0, 3).map(Number);
            console.log(`#${id}: (${nums.map(n => n.toFixed(2)).join(', ')})`);
        }
    });

console.log('\n✅ Готово! Проверь выход выше.');
console.log('💡 Совет: ищи IfcProject → LocalPlacement → RelativePlacement → Location → CartesianPoint');
