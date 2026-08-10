# Vehicle assets (Composer tour / drive / fly)

## car.glb
- **ToyCar** from [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ToyCar)
- License: **CC0 1.0 Universal**
- Authors: Guido Odendahl (model), Eric Chadwick (materials / extensions)
- Used for «Проезд» and WASD drive modes (scaled to ~4.6 m length).

## plane.glb
- **Cesium Air** from [CesiumGS/cesium](https://github.com/CesiumGS/cesium) sample data
  (`Apps/SampleData/models/CesiumAir/Cesium_Air.glb`)
- Cesium project is Apache-2.0; sample model used for «Облёт» demo visualization.
  Replace with your own GLB for production branding if needed.

## Локомотив (train)
- Модель **не файл**, а процедурная геометрия в самом вьювере
  (`createTourTrainMesh`): чужих ассетов нет, лицензионных обязательств нет,
  сеть не нужна.
- Размеры настоящие: 22.0 м по осям автосцепок (кузов 20.8), ширина 3.10,
  крыша 4.60 от УГР, со сложенным токоприёмником 4.99 — внутри габарита 1-Т
  (5300 мм, ГОСТ 9238). Колея 1520 мм, две трёхосные тележки, колёса Ø1220.
  Габарит закреплён проверкой в `npm run smoke`.
- Захотите свою модель — положите сюда `train.glb` и включите её загрузку в
  `loadTourVehicleGltf` (ветка `isTrain`). Со Sketchfab так просто нельзя:
  там у большинства моделей CC-BY (обязательна ссылка на автора), а часть под
  Sketchfab Standard — её вообще нельзя класть в репозиторий и раздавать.
  Лицензию проверяйте у конкретной модели до коммита.
