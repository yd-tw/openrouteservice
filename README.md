# Test Case

## 路障

起點：121.5430, 25.0418（忠孝復興站東側）
終點：121.5510, 25.0413（忠孝敦化站東側）
封閉：（121.5469574, 25.0417918）

GET https://openrouteservice.ydtw.net/api/navigate?origin=121.5430,25.0418&destination=121.5510,25.0413&mode=car
GET https://openrouteservice.ydtw.net/api/navigate-avoid?origin=121.5430,25.0418&destination=121.5510,25.0413&mode=car

## 人行道覆蓋

https://openrouteservice.ydtw.net/api/navigate?origin=121.5470,25.1180&destination=121.5485,25.1020&mode=pedestrian

## 大眾運輸

https://openrouteservice.ydtw.net/api/navigate?origin=121.5170,25.0478&destination=121.5675,25.0359&mode=transit
