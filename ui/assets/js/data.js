/* ============================================================
   Trace Planner · Data
   按 §6 字段契约建模的完整演示数据：
   8 天北疆自驾 Trip（v7）+ Derived 校验 + 对话脚本 + 版本历史 + 行程列表
   坐标为真实经纬度（高德 GCJ-02 近似）。
   ============================================================ */

window.TP_DATA = (function () {
  'use strict';

  /* ---------- 购票渠道工具 ---------- */
  const ch = (name, type, detail, note) => ({ name, type, detail, note });

  /* ============================================================
     Trip · 新疆环线 8天7晚 自驾（5月1日–5月8日）
     ============================================================ */
  const trip = {
    tripId: 'xj-2026-wuyi',
    title: '新疆环线 · 五一自驾',
    version: 7,
    updatedAt: '2026-04-26 21:14',
    constraints: {
      origin: '上海',
      dateRange: { start: '2026-05-01', end: '2026-05-08', note: '只有 5.1–5.8 有假，不能再延' },
      travelers: 2,
      budget: { total: 25000, level: 'mid', perPersonEst: 10730 },
      transportMode: 'self_drive',
      vehicle: {
        pickup: '乌鲁木齐地窝堡机场 · 神州租车',
        dropoff: '伊宁机场店（异地还车）',
        rentalChannel: '神州租车 App',
        permits: [
          { name: '边境管理区通行证', whereToApply: '布尔津县政务服务中心 / 「新疆边防」公众号', leadTimeDays: 0, appliesTo: '喀纳斯 · 禾木（白哈巴需查验）' }
        ]
      },
      pace: 'relaxed',
      diet: ['不吃内脏', '喜欢牛羊肉'],
      mustGo: [
        { name: '喀纳斯湖', amapPoiId: 'B0FFH3V5Q2' },
        { name: '赛里木湖', amapPoiId: 'B03E700I9K' },
        { name: '独库公路', amapPoiId: 'B0FFHKQ31X', note: '季节性开放，见冲突' }
      ],
      mustAvoid: [{ name: '购物团点位', amapPoiId: null }],
      assumptions: [
        '按 2 人 / 中等预算估算，可修改',
        '机票按经济舱全价预估，五一时段实际可能上浮 15–20%',
        '喀纳斯、禾木住宿按景区内木屋标间估算',
        '独库公路按往年 6 月上旬开放预估 —— 五一期间大概率封路'
      ]
    },

    days: [
      /* ---------- Day 1 · 5月1日 · 上海 ✈ 乌鲁木齐 ---------- */
      {
        dayIndex: 1, date: '2026-05-01', theme: '上海 → 乌鲁木齐 · 落地适应',
        rhythm: { wake: '05:30', sleep: '23:30' },
        stops: [
          {
            stopId: 'd1s1', seq: 1,
            poi: { name: '乌鲁木齐 · 新疆国际大巴扎', amapPoiId: 'B0FFG1K9A0', lng: 87.6165, lat: 43.7915, city: '乌鲁木齐市', address: '天山区解放南路8号' },
            nearbyFood: [
              { name: '血站大盘鸡', dishes: ['大盘鸡', '皮带面'], note: '本地人排队店，人均 ¥55' },
              { name: '一品烤包子（二道桥店）', dishes: ['烤包子', '酸奶粽子'], note: '大巴扎步行 5 分钟' }
            ],
            activities: [
              {
                activityId: 'd1s1a1', seq: 1, type: 'long_transit',
                title: '上海虹桥 ✈ 乌鲁木齐地窝堡',
                timeWindow: { start: '08:00', end: '13:20' },
                note: '飞行约 5 小时 20 分，与内地有约 2 小时实际时差（作息整体后移）',
                tips: ['选左侧靠窗可看天山雪峰', '落地后手表/作息按新疆时间调整'],
                transitFromPrev: null,
                transitDetail: { mode: 'flight', flightNo: 'CA1234', airline: '国航', airportFrom: '上海虹桥 T2', airportTo: '乌鲁木齐地窝堡 T3', depTime: '08:00', arrTime: '13:20' },
                ticket: {
                  kind: 'transport', priceRange: [1280, 1580], currency: 'CNY', leadTimeDays: 11, realNameRequired: true,
                  channels: [ch('航司官方 App', 'app', '国航 App · 值机选座', '改签最方便'), ch('携程旅行', 'ota', '机票 · 上海→乌鲁木齐', null), ch('飞猪', 'ota', '机票频道', null)],
                  recommendedPurchase: { targetDate: '2026-05-01', session: '早班 08:00', leadTimeDays: 11, note: '五一首日票紧，建议 4月20日 前锁定' },
                  note: '含 20kg 托运'
                }
              },
              {
                activityId: 'd1s1a2', seq: 2, type: 'visit',
                title: '新疆国际大巴扎 · 步行街与观光塔',
                timeWindow: { start: '16:00', end: '19:00' },
                note: '落地取车后轻松逛，适应时差不安排强度',
                tips: ['观光塔门票另购，时间紧可不登塔', '步行街晚上有民族歌舞表演（免费）'],
                transitFromPrev: { mode: 'drive', minutes: 35, distanceKm: 21 },
                ticket: { kind: 'none', priceRange: [0, 0], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [], recommendedPurchase: null, note: '街区免费开放' }
              },
              {
                activityId: 'd1s1a3', seq: 3, type: 'meal',
                title: '晚餐 · 手抓肉 + 椒麻鸡',
                timeWindow: { start: '19:30', end: '21:00' },
                note: '',
                tips: [],
                transitFromPrev: { mode: 'walk', minutes: 8, distanceKm: 0.6 },
                foodDetail: { shopName: '海尔巴格餐厅（大巴扎店）', dishes: ['手抓肉', '椒麻鸡', '格瓦斯'], perPersonPrice: 85 }
              },
              {
                activityId: 'd1s1a4', seq: 4, type: 'stay',
                title: '住宿 · 乌鲁木齐天山大厦',
                timeWindow: { start: '21:30', end: '23:30' },
                note: '四钻 · 距明日出城高速口 10 分钟',
                tips: ['含双早，明早可打包路上吃'],
                transitFromPrev: { mode: 'drive', minutes: 12, distanceKm: 5 },
                ticket: {
                  kind: 'hotel', priceRange: [480, 560], currency: 'CNY', leadTimeDays: 9, realNameRequired: true,
                  channels: [ch('携程酒店', 'ota', '搜「乌鲁木齐天山大厦」', null), ch('美团', 'ota', '酒店频道', '偶尔有立减券')],
                  recommendedPurchase: { targetDate: '2026-05-01', session: '5月1日 1晚', leadTimeDays: 9, note: '五一房价上浮快，4月22日 前订可锁价' },
                  note: '免费停车'
                }
              }
            ]
          }
        ]
      },

      /* ---------- Day 2 · 5月2日 · 乌鲁木齐 → 可可托海 ---------- */
      {
        dayIndex: 2, date: '2026-05-02', theme: '准噶尔盆地东缘 → 可可托海',
        rhythm: { wake: '08:00', sleep: '23:30' },
        stops: [
          {
            stopId: 'd2s1', seq: 1,
            poi: { name: '可可托海景区 · 额尔齐斯大峡谷', amapPoiId: 'B0FFHR22K1', lng: 89.7204, lat: 47.1912, city: '阿勒泰地区富蕴县', address: '可可托海镇' },
            nearbyFood: [
              { name: '可可托海牧场家宴', dishes: ['清炖羊肉', '包尔萨克'], note: '景区门口，人均 ¥60' }
            ],
            activities: [
              {
                activityId: 'd2s1a1', seq: 1, type: 'long_transit',
                title: '乌鲁木齐 → 富蕴 · 自驾转场',
                timeWindow: { start: '09:00', end: '15:00' },
                note: 'G216 穿越准噶尔盆地东缘，服务区少，出发前加满油',
                tips: ['恰库尔图服务区是中途唯一可靠补给点'],
                transitFromPrev: null,
                transitDetail: {
                  mode: 'self_drive', distanceKm: 486, driveMinutes: 360,
                  waypointsPoi: ['五彩湾服务区', '恰库尔图镇'],
                  roadRefs: ['G216', 'S226'],
                  roadCondition: '全程柏油路况良好，富蕴段有区间测速',
                  seasonClosure: null,
                  fuelStops: ['恰库尔图镇中石化'],
                  parking: '景区游客中心停车场 ¥10/次',
                  permitRequired: false, permitNote: null
                }
              },
              {
                activityId: 'd2s1a2', seq: 2, type: 'visit',
                title: '额尔齐斯大峡谷 · 神钟山',
                timeWindow: { start: '15:40', end: '19:30' },
                note: '区间车进沟，沿河徒步至神钟山观景台',
                tips: ['区间车末班 19:00（进沟），务必留足返程时间', '5月初河谷风大，带冲锋衣'],
                transitFromPrev: { mode: 'drive', minutes: 40, distanceKm: 52 },
                ticket: {
                  kind: 'attraction', priceRange: [150, 190], currency: 'CNY', leadTimeDays: 4, realNameRequired: true,
                  channels: [ch('微信公众号「可可托海旅游」', 'wechat_mp', '可可托海旅游', '官方直营，可退改'), ch('微信小程序「智游可可托海」', 'mini_program', '智游可可托海', null), ch('携程', 'ota', '门票 · 可可托海', null)],
                  recommendedPurchase: { targetDate: '2026-05-02', session: '5月2日 下午场', leadTimeDays: 4, note: '含门票+区间车，4月28日 前下单' },
                  note: '门票 ¥90 + 区间车 ¥60'
                }
              },
              {
                activityId: 'd2s1a3', seq: 3, type: 'stay',
                title: '住宿 · 可可托海镇宝石宾馆',
                timeWindow: { start: '21:00', end: '23:30' },
                note: '镇上条件最好的选择，有地暖',
                tips: ['镇上餐厅 22:00 后陆续打烊，晚餐建议在景区门口解决'],
                transitFromPrev: { mode: 'drive', minutes: 15, distanceKm: 9 },
                ticket: {
                  kind: 'hotel', priceRange: [320, 400], currency: 'CNY', leadTimeDays: 6, realNameRequired: true,
                  channels: [ch('美团', 'ota', '搜「可可托海宝石宾馆」', null), ch('电话直订', 'onsite', '0906-878****', '可谈含早')],
                  recommendedPurchase: { targetDate: '2026-05-02', session: '5月2日 1晚', leadTimeDays: 6, note: '镇上房源少，4月26日 前预订' },
                  note: ''
                }
              }
            ]
          }
        ]
      },

      /* ---------- Day 3 · 5月3日 · 喀纳斯 → 禾木（核心日） ---------- */
      {
        dayIndex: 3, date: '2026-05-03', theme: '喀纳斯 → 禾木',
        rhythm: { wake: '09:00', sleep: '23:30' },
        stops: [
          {
            stopId: 'd3s1', seq: 1,
            poi: { name: '阿勒泰市 · 克兰河午餐补给', amapPoiId: 'B0FFHM01P7', lng: 88.1396, lat: 47.8452, city: '阿勒泰市', address: '克兰河沿线' },
            nearbyFood: [{ name: '额河烤鱼店', dishes: ['烤狗鱼', '奶茶'], note: '克兰河边，人均 ¥70' }],
            activities: [
              {
                activityId: 'd3s1a1', seq: 1, type: 'long_transit',
                title: '可可托海 → 阿勒泰 · 自驾转场',
                timeWindow: { start: '09:30', end: '12:00' },
                note: '', tips: [],
                transitFromPrev: null,
                transitDetail: { mode: 'self_drive', distanceKm: 196, driveMinutes: 150, waypointsPoi: ['北屯市'], roadRefs: ['G216', 'S319'], roadCondition: '路况良好', seasonClosure: null, fuelStops: ['北屯中石油'], parking: '路边免费', permitRequired: false, permitNote: null }
              },
              {
                activityId: 'd3s1a2', seq: 2, type: 'meal',
                title: '午餐 · 额河烤鱼',
                timeWindow: { start: '12:00', end: '13:00' },
                note: '', tips: [],
                transitFromPrev: { mode: 'drive', minutes: 5, distanceKm: 2 },
                foodDetail: { shopName: '额河烤鱼店（克兰河路店）', dishes: ['烤狗鱼', '包尔萨克', '奶茶'], perPersonPrice: 70 }
              },
              {
                activityId: 'd3s1a3', seq: 3, type: 'visit',
                title: '加油 + 边防证核验点确认',
                timeWindow: { start: '13:00', end: '13:30' },
                note: '进布尔津前加满油；白哈巴方向查验边境通行证',
                tips: ['布尔津起全程山区，油量保持半箱以上'],
                transitFromPrev: { mode: 'drive', minutes: 8, distanceKm: 4 },
                ticket: { kind: 'none', priceRange: [0, 0], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [], recommendedPurchase: null, note: '' }
              }
            ]
          },
          {
            stopId: 'd3s2', seq: 2,
            poi: { name: '布尔津 · 五彩滩', amapPoiId: 'B0FFHN55T2', lng: 86.8744, lat: 47.8045, city: '阿勒泰地区布尔津县', address: '县城北侧额尔齐斯河北岸' },
            nearbyFood: [{ name: '布尔津河堤夜市', dishes: ['烤冷水鱼', '格瓦斯'], note: '晚上回来路过再吃' }],
            activities: [
              {
                activityId: 'd3s2a1', seq: 1, type: 'visit',
                title: '五彩滩 · 雅丹地貌观景',
                timeWindow: { start: '15:30', end: '16:40' },
                note: '顺路短停 1 小时，主观景台看额河北岸雅丹',
                tips: ['日落场最美但会与禾木行程冲突，此程放弃'],
                transitFromPrev: { mode: 'drive', minutes: 145, distanceKm: 148 },
                ticket: { kind: 'attraction', priceRange: [50, 50], currency: 'CNY', leadTimeDays: 1, realNameRequired: false, channels: [ch('美团', 'ota', '门票 · 五彩滩', null), ch('现场购票', 'onsite', '景区售票处', '旺季排队 20 分钟')], recommendedPurchase: null, note: '' }
              }
            ]
          },
          {
            stopId: 'd3s3', seq: 3,
            poi: { name: '喀纳斯湖 · 三湾徒步', amapPoiId: 'B0FFH3V5Q2', lng: 87.0206, lat: 48.7231, city: '阿勒泰地区布尔津县', address: '喀纳斯景区（贾登峪门票站进）' },
            nearbyFood: [],
            activities: [
              {
                activityId: 'd3s3a1', seq: 1, type: 'visit',
                title: '三湾徒步 · 神仙湾–月亮湾–卧龙湾',
                timeWindow: { start: '17:30', end: '19:30' },
                note: '区间车至神仙湾下，沿栈道徒步约 5km 依次看三湾',
                tips: ['区间车末班 19:00（换乘中心方向），徒步需控制节奏', '5月初栈道部分残雪，防滑鞋'],
                transitFromPrev: { mode: 'drive', minutes: 95, distanceKm: 86 },
                ticket: {
                  kind: 'attraction', priceRange: [230, 280], currency: 'CNY', leadTimeDays: 3, realNameRequired: true,
                  channels: [ch('微信公众号「喀纳斯景区」', 'wechat_mp', '喀纳斯景区', '官方首选，实名预约'), ch('微信小程序「喀纳斯智慧旅游」', 'mini_program', '喀纳斯智慧旅游', null), ch('美团 / 携程', 'ota', '门票 · 喀纳斯', null)],
                  recommendedPurchase: { targetDate: '2026-05-03', session: '5月3日 上午场', leadTimeDays: 3, note: '最迟 4月30日 下单；门票+区间车一票制' },
                  note: '门票 ¥160 + 区间车 ¥70–120'
                }
              }
            ]
          },
          {
            stopId: 'd3s4', seq: 4,
            poi: { name: '禾木村 · 日落观景', amapPoiId: 'B0FFHP88W3', lng: 87.4167, lat: 48.8306, city: '阿勒泰地区布尔津县', address: '禾木哈纳斯民族乡' },
            nearbyFood: [{ name: '禾木山庄餐厅', dishes: ['手抓肉', '奶茶'], note: '住宿楼下，人均 ¥80' }],
            activities: [
              {
                activityId: 'd3s4a1', seq: 1, type: 'visit',
                title: '禾木日落 · 哈登观景台',
                timeWindow: { start: '19:00', end: '21:30' },
                note: '日落约 21:20（新疆时间），观景台俯瞰全村炊烟',
                tips: ['观景台徒步上山约 20 分钟，也可骑马 ¥50', '日落后骤冷，抓绒+外套'],
                transitFromPrev: { mode: 'drive', minutes: 70, distanceKm: 62 },
                ticket: {
                  kind: 'attraction', priceRange: [102, 102], currency: 'CNY', leadTimeDays: 3, realNameRequired: true,
                  channels: [ch('微信公众号「喀纳斯景区」', 'wechat_mp', '喀纳斯景区', '禾木门票同公众号购买'), ch('微信小程序「喀纳斯智慧旅游」', 'mini_program', '喀纳斯智慧旅游', null)],
                  recommendedPurchase: { targetDate: '2026-05-03', session: '与喀纳斯联票', leadTimeDays: 3, note: '禾木门票 ¥50 + 区间车 ¥52' },
                  note: ''
                }
              },
              {
                activityId: 'd3s4a2', seq: 2, type: 'stay',
                title: '住宿 · 禾木山庄（景区内木屋）',
                timeWindow: { start: '22:00', end: '23:30' },
                note: '景区内住宿贵但省去二次进沟',
                tips: ['木屋隔音一般，备耳塞', '明早看晨雾步行 10 分钟到禾木桥'],
                transitFromPrev: { mode: 'walk', minutes: 10, distanceKm: 0.8 },
                ticket: {
                  kind: 'hotel', priceRange: [680, 880], currency: 'CNY', leadTimeDays: 7, realNameRequired: true,
                  channels: [ch('微信公众号「喀纳斯景区」', 'wechat_mp', '喀纳斯景区 · 住宿预订', '景区直营'), ch('携程', 'ota', '搜「禾木山庄」', null)],
                  recommendedPurchase: { targetDate: '2026-05-03', session: '5月3日 1晚', leadTimeDays: 7, note: '五一禾木住宿最紧张，4月26日 前必订' },
                  note: ''
                }
              }
            ]
          }
        ]
      },

      /* ---------- Day 4 · 5月4日 · 禾木 → 魔鬼城 → 奎屯 ---------- */
      {
        dayIndex: 4, date: '2026-05-04', theme: '禾木晨雾 → 乌尔禾魔鬼城',
        rhythm: { wake: '07:00', sleep: '23:30' },
        stops: [
          {
            stopId: 'd4s1', seq: 1,
            poi: { name: '禾木河谷 · 晨雾观景', amapPoiId: 'B0FFHP88W4', lng: 87.4231, lat: 48.8352, city: '阿勒泰地区布尔津县', address: '禾木桥–美丽峰方向' },
            nearbyFood: [],
            activities: [
              {
                activityId: 'd4s1a1', seq: 1, type: 'visit',
                title: '禾木晨雾 · 禾木桥日出',
                timeWindow: { start: '07:30', end: '09:30' },
                note: '清晨河谷炊烟与晨雾，5月日出约 07:10',
                tips: ['最佳机位在禾木桥东侧河岸', '零下气温，手套帽子'],
                transitFromPrev: { mode: 'walk', minutes: 10, distanceKm: 0.8 },
                ticket: { kind: 'none', priceRange: [0, 0], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [], recommendedPurchase: null, note: '含在昨日禾木门票内' }
              }
            ]
          },
          {
            stopId: 'd4s2', seq: 2,
            poi: { name: '乌尔禾世界魔鬼城', amapPoiId: 'B0FFHJ61D8', lng: 85.6872, lat: 46.0984, city: '克拉玛依市乌尔禾区', address: 'G217 与 S201 交叉口东北' },
            nearbyFood: [],
            activities: [
              {
                activityId: 'd4s2a1', seq: 1, type: 'long_transit',
                title: '禾木 → 乌尔禾 · 自驾转场',
                timeWindow: { start: '10:00', end: '15:30' },
                note: '出山路窄，布尔津午餐后上高速',
                tips: [],
                transitFromPrev: { mode: 'drive', minutes: 45, distanceKm: 52 },
                transitDetail: { mode: 'self_drive', distanceKm: 430, driveMinutes: 330, waypointsPoi: ['布尔津县', '和布克赛尔'], roadRefs: ['S232', 'G3014'], roadCondition: '高速为主，戈壁段注意横风', seasonClosure: null, fuelStops: ['布尔津中石化', '乌尔禾服务区'], parking: '景区停车场免费', permitRequired: false, permitNote: null }
              },
              {
                activityId: 'd4s2a2', seq: 2, type: 'visit',
                title: '魔鬼城 · 观光小火车雅丹环线',
                timeWindow: { start: '16:00', end: '19:00' },
                note: '日落前光线最佳，风蚀城堡群',
                tips: ['戈壁大风，帽子墨镜收好', '小火车末班 19:30'],
                transitFromPrev: { mode: 'walk', minutes: 3, distanceKm: 0.2 },
                ticket: { kind: 'attraction', priceRange: [68, 98], currency: 'CNY', leadTimeDays: 1, realNameRequired: false, channels: [ch('微信公众号「克拉玛依文旅」', 'wechat_mp', '克拉玛依文旅', null), ch('携程', 'ota', '门票 · 魔鬼城', null)], recommendedPurchase: null, note: '含区间小火车' }
              }
            ]
          },
          {
            stopId: 'd4s3', seq: 3,
            poi: { name: '奎屯市 · 住宿补给', amapPoiId: 'B0FFHK30C9', lng: 84.9017, lat: 44.4252, city: '伊犁州奎屯市', address: '乌鲁木齐西路' },
            nearbyFood: [{ name: '奎屯凉皮黄面烤肉三件套', dishes: ['凉皮', '烤肉'], note: '夜市人均 ¥30' }],
            activities: [
              {
                activityId: 'd4s3a1', seq: 1, type: 'stay',
                title: '住宿 · 奎屯锦江都城',
                timeWindow: { start: '21:30', end: '23:30' },
                note: '中转补给点，明早直奔赛里木湖',
                tips: ['加满油再休息，明早行程 2.5h'],
                transitFromPrev: { mode: 'drive', minutes: 150, distanceKm: 235 },
                ticket: { kind: 'hotel', priceRange: [300, 380], currency: 'CNY', leadTimeDays: 4, realNameRequired: true, channels: [ch('携程', 'ota', '搜「奎屯锦江都城」', null)], recommendedPurchase: null, note: '' }
              }
            ]
          }
        ]
      },

      /* ---------- Day 5 · 5月5日 · 赛里木湖 ---------- */
      {
        dayIndex: 5, date: '2026-05-05', theme: '赛里木湖环湖一整天',
        rhythm: { wake: '08:00', sleep: '23:00' },
        stops: [
          {
            stopId: 'd5s1', seq: 1,
            poi: { name: '赛里木湖 · 环湖自驾', amapPoiId: 'B03E700I9K', lng: 81.1671, lat: 44.6083, city: '博尔塔拉州博乐市', address: 'G30 连霍高速赛里木湖出口' },
            nearbyFood: [{ name: '湖区毡房餐厅', dishes: ['纳仁', '奶茶'], note: '点将台附近，人均 ¥90，只收现金或信号好时扫码' }],
            activities: [
              {
                activityId: 'd5s1a1', seq: 1, type: 'visit',
                title: '环湖自驾 · 顺时针全环 90km',
                timeWindow: { start: '09:00', end: '13:00' },
                note: '点将台–天鹅广场–西海草原依次停靠；v7 已把环湖调整到上午（光线顺、人少）',
                tips: ['5月初湖面可能仍有残冰「蓝冰」，留意安全提示', '环湖限速 40–60，全程 2.5h 纯驾车'],
                transitFromPrev: { mode: 'drive', minutes: 150, distanceKm: 246 },
                ticket: {
                  kind: 'attraction', priceRange: [140, 145], currency: 'CNY', leadTimeDays: 2, realNameRequired: true,
                  channels: [ch('微信公众号「赛里木湖旅游」', 'wechat_mp', '赛里木湖旅游', '官方购票+区间车'), ch('携程', 'ota', '门票 · 赛里木湖', null)],
                  recommendedPurchase: { targetDate: '2026-05-05', session: '5月5日 上午场', leadTimeDays: 2, note: '自驾环湖需另付车辆进入费' },
                  note: '门票 ¥70 + 环湖自驾费 ¥70–75/车'
                }
              },
              {
                activityId: 'd5s1a2', seq: 2, type: 'free',
                title: '湖畔自由活动',
                timeWindow: { start: '14:00', end: '18:00' },
                note: '西海草原发呆 / 补拍照片，节奏自己定',
                tips: [],
                transitFromPrev: null,
                ticket: { kind: 'none', priceRange: [0, 0], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [], recommendedPurchase: null, note: '' }
              },
              {
                activityId: 'd5s1a3', seq: 3, type: 'stay',
                title: '住宿 · 赛里木湖景区毡房营地（升级版）',
                timeWindow: { start: '20:00', end: '23:00' },
                note: '湖景星空毡房，公共卫浴升级版；怕冷可退到博乐市区酒店',
                tips: ['夜间湖边 0°C 左右，睡袋内胆自备更卫生', '看星空远离停车场灯光'],
                transitFromPrev: { mode: 'drive', minutes: 10, distanceKm: 6 },
                ticket: {
                  kind: 'hotel', priceRange: [560, 760], currency: 'CNY', leadTimeDays: 5, realNameRequired: true,
                  channels: [ch('微信公众号「赛里木湖旅游」', 'wechat_mp', '赛里木湖旅游 · 营地预订', null), ch('美团', 'ota', '搜「赛里木湖毡房」', null)],
                  recommendedPurchase: { targetDate: '2026-05-05', session: '5月5日 1晚', leadTimeDays: 5, note: '4月30日 前预订，五一湖景房极紧张' },
                  note: ''
                }
              }
            ]
          }
        ]
      },

      /* ---------- Day 6 · 5月6日 · 赛里木湖 → 伊宁 ---------- */
      {
        dayIndex: 6, date: '2026-05-06', theme: '果子沟大桥 → 伊宁老城',
        rhythm: { wake: '07:30', sleep: '23:00' },
        stops: [
          {
            stopId: 'd6s1', seq: 1,
            poi: { name: '伊宁 · 喀赞其民俗旅游区', amapPoiId: 'B0FFHQ21M4', lng: 81.3297, lat: 43.9128, city: '伊犁州伊宁市', address: '喀赞其街道' },
            nearbyFood: [{ name: '喀赞其家访宴', dishes: ['马肠子纳仁', '冰淇淋'], note: '蓝色小院家访宴，需提前电话约，人均 ¥75' }],
            activities: [
              {
                activityId: 'd6s1a1', seq: 1, type: 'long_transit',
                title: '赛里木湖 → 伊宁 · 果子沟大桥',
                timeWindow: { start: '09:00', end: '11:30' },
                note: 'G30 经果子沟大桥下山，桥面禁止停车，观景台在服务区',
                tips: ['果子沟服务区可回望大桥全景', '下坡长，注意刹车温度'],
                transitFromPrev: null,
                transitDetail: { mode: 'self_drive', distanceKm: 130, driveMinutes: 120, waypointsPoi: ['果子沟大桥', '果子沟服务区'], roadRefs: ['G30'], roadCondition: '山区高速，隧道多', seasonClosure: null, fuelStops: [], parking: '喀赞其周边收费停车场', permitRequired: false, permitNote: null }
              },
              {
                activityId: 'd6s1a2', seq: 2, type: 'visit',
                title: '喀赞其 · 蓝色老城马车巡游',
                timeWindow: { start: '14:00', end: '17:30' },
                note: '哈迪克马车穿巷，蓝色民居与手工艺小院',
                tips: ['马车线路约 1h，剩下时间步行逛', '家访需另付 ¥30–50'],
                transitFromPrev: { mode: 'drive', minutes: 20, distanceKm: 8 },
                ticket: { kind: 'attraction', priceRange: [50, 100], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [ch('现场购票', 'onsite', '喀赞其游客中心', '马车+讲解套票'), ch('美团', 'ota', '门票 · 喀赞其', null)], recommendedPurchase: null, note: '' }
              }
            ]
          },
          {
            stopId: 'd6s2', seq: 2,
            poi: { name: '伊宁 · 六星街', amapPoiId: 'B0FFHQ21M5', lng: 81.3177, lat: 43.9211, city: '伊犁州伊宁市', address: '六星街景区' },
            nearbyFood: [],
            activities: [
              {
                activityId: 'd6s2a1', seq: 1, type: 'meal',
                title: '晚餐 · 六星街庭院餐厅',
                timeWindow: { start: '19:00', end: '21:00' },
                note: '', tips: ['手风琴博物馆就在街口，饭后顺看'],
                transitFromPrev: { mode: 'drive', minutes: 10, distanceKm: 3 },
                foodDetail: { shopName: '亚历山大庭院餐厅', dishes: ['罐罐牛肉', '奶疙瘩', '卡瓦斯'], perPersonPrice: 95 }
              },
              {
                activityId: 'd6s2a2', seq: 2, type: 'stay',
                title: '住宿 · 伊宁天缘国际酒店',
                timeWindow: { start: '21:30', end: '23:00' },
                note: '市中心四钻，明早出发去特克斯方便',
                tips: [],
                transitFromPrev: { mode: 'walk', minutes: 12, distanceKm: 1 },
                ticket: { kind: 'hotel', priceRange: [420, 500], currency: 'CNY', leadTimeDays: 3, realNameRequired: true, channels: [ch('携程', 'ota', '搜「伊宁天缘国际」', null)], recommendedPurchase: null, note: '' }
              }
            ]
          }
        ]
      },

      /* ---------- Day 7 · 5月7日 · 特克斯八卦城 ---------- */
      {
        dayIndex: 7, date: '2026-05-07', theme: '特克斯八卦城 → 琼库什台',
        rhythm: { wake: '08:30', sleep: '23:00' },
        stops: [
          {
            stopId: 'd7s1', seq: 1,
            poi: { name: '特克斯八卦城 · 离街', amapPoiId: 'B0FFHR90K6', lng: 81.8399, lat: 43.2148, city: '伊犁州特克斯县', address: '八卦城中心' },
            nearbyFood: [{ name: '离街架子肉老店', dishes: ['架子肉', '酸奶'], note: '人均 ¥85' }],
            activities: [
              {
                activityId: 'd7s1a1', seq: 1, type: 'visit',
                title: '八卦城观光塔 + 离街漫步',
                timeWindow: { start: '11:00', end: '13:00' },
                note: '全球唯一保存完整的八卦布局城市',
                tips: ['观光塔顶看八卦全景，¥30'],
                transitFromPrev: { mode: 'drive', minutes: 130, distanceKm: 118 },
                ticket: { kind: 'attraction', priceRange: [0, 30], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [ch('现场购票', 'onsite', '观光塔售票处', null)], recommendedPurchase: null, note: '街区免费' }
              }
            ]
          },
          {
            stopId: 'd7s2', seq: 2,
            poi: { name: '琼库什台村', amapPoiId: 'B0FFHR90K7', lng: 82.0986, lat: 43.0503, city: '伊犁州特克斯县', address: '喀拉达拉镇琼库什台村' },
            nearbyFood: [],
            activities: [
              {
                activityId: 'd7s2a1', seq: 1, type: 'visit',
                title: '琼库什台 · 乌孙古道入口河谷',
                timeWindow: { start: '14:30', end: '18:30' },
                note: '原木哈萨克村落 + 河谷草甸短徒步（4km 往返）',
                tips: ['进村最后 20km 砂石路，轿车慢行可过', '无信号，提前离线地图'],
                transitFromPrev: { mode: 'drive', minutes: 90, distanceKm: 62 },
                ticket: { kind: 'none', priceRange: [30, 30], currency: 'CNY', leadTimeDays: 0, realNameRequired: false, channels: [ch('现场购票', 'onsite', '村口生态费 ¥30/人', null)], recommendedPurchase: null, note: '' }
              },
              {
                activityId: 'd7s2a2', seq: 2, type: 'stay',
                title: '住宿 · 特克斯君邦酒店',
                timeWindow: { start: '21:00', end: '23:00' },
                note: '返回县城住宿（琼库什台无标准住宿）',
                tips: ['明早还车前加满油，机场店验车'],
                transitFromPrev: { mode: 'drive', minutes: 90, distanceKm: 62 },
                ticket: { kind: 'hotel', priceRange: [340, 420], currency: 'CNY', leadTimeDays: 2, realNameRequired: true, channels: [ch('携程', 'ota', '搜「特克斯君邦」', null)], recommendedPurchase: null, note: '' }
              }
            ]
          }
        ]
      },

      /* ---------- Day 8 · 5月8日 · 返程 ---------- */
      {
        dayIndex: 8, date: '2026-05-08', theme: '伊宁 ✈ 乌鲁木齐 ✈ 上海',
        rhythm: { wake: '07:00', sleep: '23:30' },
        stops: [
          {
            stopId: 'd8s1', seq: 1,
            poi: { name: '伊宁机场 · 还车登机', amapPoiId: 'B0FFHS01Z2', lng: 81.3303, lat: 43.9551, city: '伊犁州伊宁市', address: '伊宁机场' },
            nearbyFood: [],
            activities: [
              {
                activityId: 'd8s1a1', seq: 1, type: 'long_transit',
                title: '特克斯 → 伊宁机场 · 还车',
                timeWindow: { start: '08:00', end: '10:30' },
                note: '机场店还车，验车约 30 分钟',
                tips: ['加满油还车（机场口加油站）', '异地还车费 ¥600 已计入预算'],
                transitFromPrev: null,
                transitDetail: { mode: 'self_drive', distanceKm: 150, driveMinutes: 130, waypointsPoi: [], roadRefs: ['G577'], roadCondition: '路况良好', seasonClosure: null, fuelStops: ['伊宁机场加油站'], parking: '还车即停', permitRequired: false, permitNote: null }
              },
              {
                activityId: 'd8s1a2', seq: 2, type: 'long_transit',
                title: '伊宁 ✈ 乌鲁木齐',
                timeWindow: { start: '12:40', end: '14:00' },
                note: '', tips: ['预留 2h 中转时间衔接下一班'],
                transitFromPrev: { mode: 'walk', minutes: 10, distanceKm: 0.5 },
                transitDetail: { mode: 'flight', flightNo: 'GS7542', airline: '天津航空', airportFrom: '伊宁机场', airportTo: '乌鲁木齐地窝堡 T2', depTime: '12:40', arrTime: '14:00' },
                ticket: { kind: 'transport', priceRange: [420, 560], currency: 'CNY', leadTimeDays: 10, realNameRequired: true, channels: [ch('航司官方 App', 'app', '天津航空 App', null), ch('携程', 'ota', '机票 · 伊宁→乌鲁木齐', null)], recommendedPurchase: { targetDate: '2026-05-08', session: '午班 12:40', leadTimeDays: 10, note: '4月28日 前购买' }, note: '' }
              },
              {
                activityId: 'd8s1a3', seq: 3, type: 'long_transit',
                title: '乌鲁木齐 ✈ 上海虹桥',
                timeWindow: { start: '16:10', end: '21:20' },
                note: '', tips: ['落地虹桥已 21:20，回家预留 1h'],
                transitFromPrev: null,
                transitDetail: { mode: 'flight', flightNo: 'CZ6989', airline: '南航', airportFrom: '乌鲁木齐地窝堡 T2', airportTo: '上海虹桥 T2', depTime: '16:10', arrTime: '21:20' },
                ticket: { kind: 'transport', priceRange: [1150, 1450], currency: 'CNY', leadTimeDays: 11, realNameRequired: true, channels: [ch('航司官方 App', 'app', '南航 App', null), ch('携程', 'ota', '机票 · 乌鲁木齐→上海', null)], recommendedPurchase: { targetDate: '2026-05-08', session: '下午班 16:10', leadTimeDays: 11, note: '五一返程票最紧张，4月20日 前必须出票' }, note: '' }
              }
            ]
          }
        ]
      }
    ],

    revisionLog: [
      { version: 1, time: '04-24 20:03', userRequest: '马上五一了，我想去新疆旅游，给个推荐路线', summary: '生成初版骨架：北疆大环线 8 天，含喀纳斯与赛里木湖', opCount: 34, changedStopIds: ['*'] },
      { version: 2, time: '04-24 20:11', userRequest: '（回答澄清问题：8天 / 上海出发 / 自驾）', summary: '按 8天7晚 · 上海往返 · 自驾重排全程，锁定日期 5.1–5.8', opCount: 22, changedStopIds: ['*'] },
      { version: 3, time: '04-24 21:40', userRequest: '喀纳斯和赛里木湖必须去，想吃手抓肉', summary: '喀纳斯升为过夜点，新增禾木住宿；D1/D3 加入手抓肉餐厅', opCount: 9, changedStopIds: ['d3s3', 'd3s4', 'd1s1'] },
      { version: 4, time: '04-25 09:12', userRequest: '排得太满了，松弛一点', summary: 'pace 调整为 relaxed，删减 2 个次级景点，每日预留自由时间', opCount: 12, changedStopIds: ['d2s1', 'd5s1', 'd6s2'] },
      { version: 5, time: '04-25 15:47', userRequest: '把独库公路也加上', summary: 'D7 重排为独库北段穿越（伊宁→那拉提→独山子）', opCount: 15, changedStopIds: ['d7s1', 'd7s2'] },
      { version: 6, time: '04-25 15:49', userRequest: '（校验器自动触发：独库公路 5 月初未开放）', summary: 'D7 改排特克斯八卦城+琼库什台；保留「独库公路」冲突待用户决策', opCount: 8, changedStopIds: ['d7s1', 'd7s2'] },
      { version: 7, time: '04-26 21:14', userRequest: '赛里木湖那天想早点环湖，下午留着发呆', summary: 'D5 环湖 14:00→09:00，下午改为自由活动，住宿不变', opCount: 4, changedStopIds: ['d5s1'] }
    ]
  };

  /* ---------- 各版本 diff 预览（版本历史抽屉用） ---------- */
  const versionDiffs = {
    7: [
      { op: 'mod', text: 'D5 赛里木湖 · 环湖自驾 <span class="num">14:00–18:00</span> <span class="d-arrow">→</span> <span class="num">09:00–13:00</span>' },
      { op: 'add', text: 'D5 新增「湖畔自由活动」<span class="num">14:00–18:00</span>（free）' },
      { op: 'mod', text: 'D5 环湖备注更新：上午光线顺、人少' },
      { op: 'keep', text: 'D5 住宿 · 赛里木湖毡房营地（未变更）' }
    ],
    6: [
      { op: 'del', text: 'D7 独库公路北段穿越（伊宁→那拉提→独山子）' },
      { op: 'add', text: 'D7 特克斯八卦城 · 离街（<span class="num">11:00–13:00</span>）' },
      { op: 'add', text: 'D7 琼库什台村 · 河谷短徒步（<span class="num">14:30–18:30</span>）' },
      { op: 'mod', text: 'D7 住宿：那拉提镇 <span class="d-arrow">→</span> 特克斯君邦酒店' },
      { op: 'add', text: '冲突保留：独库公路 season_closed（error）待用户决策' }
    ],
    5: [
      { op: 'del', text: 'D7 伊宁自由日（free ×2）' },
      { op: 'add', text: 'D7 独库公路北段：乔尔玛纪念碑、哈希勒根达坂' },
      { op: 'mod', text: 'D7 自驾里程 <span class="num">36km</span> <span class="d-arrow">→</span> <span class="num">412km</span>' }
    ],
    4: [
      { op: 'del', text: 'D2 富蕴县城博物馆（次级景点）' },
      { op: 'del', text: 'D6 伊犁河大桥日落（与喀赞其冲突）' },
      { op: 'add', text: 'D5 湖畔自由时段（首次引入留白）' },
      { op: 'mod', text: 'pace：intense <span class="d-arrow">→</span> relaxed' }
    ],
    3: [
      { op: 'mod', text: 'D3 喀纳斯：当日往返 <span class="d-arrow">→</span> 禾木过夜' },
      { op: 'add', text: 'D3 禾木村 · 日落观景 + 禾木山庄住宿' },
      { op: 'add', text: 'D1 晚餐 · 海尔巴格手抓肉' }
    ],
    2: [
      { op: 'mod', text: '全程按 8天7晚 · 5.1–5.8 重排（原 6 天）' },
      { op: 'add', text: 'D1 上海 ✈ 乌鲁木齐 CA1234' },
      { op: 'add', text: 'D8 伊宁 ✈ 乌鲁木齐 ✈ 上海 返程' },
      { op: 'mod', text: '交通方式：跟团大巴 <span class="d-arrow">→</span> 自驾（乌鲁木齐取车 / 伊宁还车）' }
    ],
    1: [
      { op: 'add', text: '初版北疆大环线骨架：乌鲁木齐–可可托海–喀纳斯–赛里木湖–伊宁' },
      { op: 'add', text: '16 个地点 · 24 项活动' }
    ]
  };

  /* ============================================================
     Derived · 服务端校验器推导
     ============================================================ */
  const derived = {
    days: {
      1: { window: { firstStart: '08:00', lastEnd: '23:30', totalHours: 15.5, transitHours: 5.9 }, loadHours: 9.2, conflicts: [] },
      2: { window: { firstStart: '09:00', lastEnd: '23:30', totalHours: 14.5, transitHours: 6.7 }, loadHours: 10.6, conflicts: ['rhythm_violation_d2'] },
      3: { window: { firstStart: '09:30', lastEnd: '23:30', totalHours: 14.0, transitHours: 6.6 }, loadHours: 13.1, conflicts: ['time_overlap_d3', 'day_overload_d3'] },
      4: { window: { firstStart: '07:30', lastEnd: '23:30', totalHours: 16.0, transitHours: 9.0 }, loadHours: 10.2, conflicts: [] },
      5: { window: { firstStart: '09:00', lastEnd: '23:00', totalHours: 14.0, transitHours: 2.7 }, loadHours: 7.0, conflicts: [] },
      6: { window: { firstStart: '09:00', lastEnd: '23:00', totalHours: 14.0, transitHours: 2.3 }, loadHours: 6.8, conflicts: [] },
      7: { window: { firstStart: '08:30', lastEnd: '23:00', totalHours: 14.5, transitHours: 5.2 }, loadHours: 7.4, conflicts: [] },
      8: { window: { firstStart: '08:00', lastEnd: '21:20', totalHours: 13.3, transitHours: 6.6 }, loadHours: 6.6, conflicts: [] }
    },

    conflicts: [
      {
        id: 'season_closed_d7',
        type: 'season_closed', severity: 'error',
        dayIndex: 7, stopId: null, activityId: null,
        message: '独库公路（G217 独山子–乔尔玛段）往年 6 月上旬才开放，5月7日 无法通行。必去清单中的「独库公路」无法在本行程实现。',
        suggestedFix: '三选一：改期到 6 月出行；或接受 v6 的替代方案（特克斯+琼库什台，已排入 D7）；或把独库公路从必去清单移除。',
        askUser: {
          question: '独库公路 5 月初未开放，怎么处理？',
          options: [
            { id: 'june', label: '改到 6 月出行', noteHint: '例如 6.6–6.13，需重查机票' },
            { id: 'keep', label: '保持现方案', noteHint: '特克斯+琼库什台已排入 D7，可补充说明' },
            { id: 'sayram', label: '换成赛里木湖加一天', noteHint: '例如压缩 D4 转场' }
          ],
          allowNote: true, allowSkip: false
        }
      },
      {
        id: 'time_overlap_d3',
        type: 'time_overlap', severity: 'warning',
        dayIndex: 3, stopId: 'd3s3', activityId: 'd3s3a1',
        message: '三湾徒步（17:30–19:30）与禾木日落（19:00–21:30）时间窗重叠，且徒步结束到禾木还需 70 分钟车程。',
        suggestedFix: '把三湾徒步压缩到 17:00–18:20，或放弃三湾徒步直接进禾木（日落可完整保留）。'
      },
      {
        id: 'day_overload_d3',
        type: 'day_overload', severity: 'warning',
        dayIndex: 3, stopId: null, activityId: null,
        message: 'Day 3 活动负载 13.1 小时，超过 relaxed 节奏建议上限（10 小时），当天驾驶 5 段共 344 公里。',
        suggestedFix: '删减五彩滩（-1.2h）或把三湾徒步移到 Day 4 上午。'
      },
      {
        id: 'rhythm_violation_d2',
        type: 'rhythm_violation', severity: 'warning',
        dayIndex: 2, stopId: 'd2s1', activityId: 'd2s1a3',
        message: 'Day 2 预计 23:30 后才能入住，压着当天作息上限（sleep 23:30），峡谷徒步若延时将突破。',
        suggestedFix: '额尔齐斯大峡谷改到 Day 3 一早（需调整住宿到景区门口），或接受晚到。'
      }
    ],

    bookingTimeline: [
      { id: 'bk1', orderBy: '2026-04-20', title: '机票 · 上海→乌鲁木齐 5/1 CA1234', kind: 'flight', channelHint: '国航 App / 携程', priceRange: [1280, 1580], leadTimeDays: 11, realNameRequired: true, dayIndex: 1 },
      { id: 'bk2', orderBy: '2026-04-20', title: '机票 · 乌鲁木齐→上海 5/8 CZ6989', kind: 'flight', channelHint: '南航 App / 携程', priceRange: [1150, 1450], leadTimeDays: 11, realNameRequired: true, dayIndex: 8 },
      { id: 'bk3', orderBy: '2026-04-22', title: '酒店 · 乌鲁木齐 5/1 晚', kind: 'hotel', channelHint: '携程 · 天山大厦', priceRange: [480, 560], leadTimeDays: 9, realNameRequired: true, dayIndex: 1 },
      { id: 'bk4', orderBy: '2026-04-24', title: '租车 · 乌鲁木齐取 / 伊宁还 5/1–5/8', kind: 'car', channelHint: '神州租车 App · 含异地还车费 ¥600', priceRange: [2100, 2400], leadTimeDays: 7, realNameRequired: true, dayIndex: 1 },
      { id: 'bk5', orderBy: '2026-04-26', title: '酒店 · 禾木山庄 5/3 晚', kind: 'hotel', channelHint: '公众号「喀纳斯景区」', priceRange: [680, 880], leadTimeDays: 7, realNameRequired: true, dayIndex: 3 },
      { id: 'bk6', orderBy: '2026-04-26', title: '酒店 · 可可托海 5/2 晚', kind: 'hotel', channelHint: '美团 · 宝石宾馆', priceRange: [320, 400], leadTimeDays: 6, realNameRequired: true, dayIndex: 2 },
      { id: 'bk7', orderBy: '2026-04-28', title: '门票 · 喀纳斯+区间车 5/3', kind: 'ticket', channelHint: '公众号「喀纳斯景区」· 实名制', priceRange: [230, 280], leadTimeDays: 3, realNameRequired: true, dayIndex: 3 },
      { id: 'bk8', orderBy: '2026-04-28', title: '门票 · 禾木+区间车 5/3', kind: 'ticket', channelHint: '公众号「喀纳斯景区」', priceRange: [102, 102], leadTimeDays: 3, realNameRequired: true, dayIndex: 3 },
      { id: 'bk9', orderBy: '2026-04-28', title: '门票 · 可可托海+区间车 5/2', kind: 'ticket', channelHint: '公众号「可可托海旅游」', priceRange: [150, 190], leadTimeDays: 4, realNameRequired: true, dayIndex: 2 },
      { id: 'bk10', orderBy: '2026-04-28', title: '机票 · 伊宁→乌鲁木齐 5/8 GS7542', kind: 'flight', channelHint: '天津航空 App / 携程', priceRange: [420, 560], leadTimeDays: 10, realNameRequired: true, dayIndex: 8 },
      { id: 'bk11', orderBy: '2026-04-30', title: '门票 · 赛里木湖+环湖自驾 5/5', kind: 'ticket', channelHint: '公众号「赛里木湖旅游」', priceRange: [140, 145], leadTimeDays: 2, realNameRequired: true, dayIndex: 5 },
      { id: 'bk12', orderBy: '2026-04-30', title: '住宿 · 赛里木湖毡房营地 5/5 晚', kind: 'hotel', channelHint: '公众号「赛里木湖旅游」', priceRange: [560, 760], leadTimeDays: 5, realNameRequired: true, dayIndex: 5 }
    ],

    budgetSummary: {
      ticketsTotal: 1668, hotelsTotal: 5560, foodEstTotal: 2200, transitEstTotal: 6640,
      grandTotal: 21468, perPerson: 10734, budgetTotal: 25000, overBudgetBy: 0
    },

    ok: false,

    /* 原型演示用「今天」——让预订清单能展示逾期态 */
    today: '2026-04-26'
  };

  /* ============================================================
     对话区数据 · 三种状态
     ============================================================ */

  /* ---- 状态① 完整规划态（v7 已就绪，含独库决策悬而未决） ---- */
  const convoComplete = [
    { type: 'user', time: '04-24 20:03', text: '马上五一了，我想去新疆旅游，给个推荐路线' },
    {
      type: 'ask_user', time: '04-24 20:04', answered: true,
      intro: '为了排出合适的路线，需要确认几件事',
      questions: [
        { question: '这趟大概几天？', multi: false, options: [{ id: 'd4', label: '4 天' }, { id: 'd6', label: '6 天' }, { id: 'd8', label: '8 天' }], answer: 'd8', note: '只有 5.1–5.4 有假 → 已确认为 5.1–5.8 拼假' },
        { question: '从哪个城市出发？', multi: false, options: [{ id: 'sh', label: '上海' }, { id: 'bj', label: '北京' }, { id: 'other', label: '其他' }], answer: 'sh', note: '' },
        { question: '当地交通方式？', multi: false, options: [{ id: 'drive', label: '自驾' }, { id: 'flight', label: '飞机+包车' }, { id: 'train', label: '火车' }], answer: 'drive', note: '想走独库公路' }
      ]
    },
    {
      type: 'tools', time: '04-24 20:06', status: 'done', collapsed: true,
      items: [
        { icon: 'search', title: '搜索「北疆 五一 自驾 环线」', result: '12 条结果 · 已提取 4 条成熟路线', json: '{\n  "query": "北疆 五一 自驾 环线",\n  "results": 12,\n  "top": [\n    "乌市-可可托海-喀纳斯-赛湖-伊宁 8日",\n    "阿勒泰深度 6日",\n    "伊犁花海 7日（5月中旬后）"\n  ]\n}' },
        { icon: 'car', title: '路径规划 · 乌鲁木齐→可可托海', result: '486 公里 / 约 6 小时（G216）', json: '{\n  "from": "乌鲁木齐", "to": "可可托海",\n  "distanceKm": 486, "minutes": 360,\n  "roadRefs": ["G216","S226"]\n}' },
        { icon: 'weather', title: '查询天气 · 阿勒泰 5/1–5/8', result: '晴为主，夜间 -2°C～4°C，山区有残雪', json: '{\n  "region": "阿勒泰",\n  "range": "2026-05-01/2026-05-08",\n  "summary": "晴为主，昼夜温差 15°C+",\n  "risk": "山区垭口残雪"\n}' },
        { icon: 'search', title: '搜索「独库公路 开放时间 2026」', result: '8 条结果 · 往年 6 月上旬通车', json: '{\n  "query": "独库公路 开放时间",\n  "results": 8,\n  "conclusion": "G217 独山子-库车段往年 6/1-6/10 解除交通管制"\n}' },
        { icon: 'pin', title: 'POI 检索 · 喀纳斯 / 禾木 / 赛里木湖', result: '3 个必去点定位完成（高德 POI）', json: '{\n  "pois": [\n    {"name":"喀纳斯湖","id":"B0FFH3V5Q2"},\n    {"name":"禾木村","id":"B0FFHP88W3"},\n    {"name":"赛里木湖","id":"B03E700I9K"}\n  ]\n}' },
        { icon: 'bed', title: '搜索住宿 · 禾木 5/3 晚', result: '9 家 · 景区内木屋 ¥680 起，余量少', json: '{\n  "query": "禾木 住宿 5月3日",\n  "results": 9,\n  "note": "五一余量紧张"\n}' }
      ]
    },
    { type: 'ai', time: '04-24 20:09', md: '已经排好初版 **8 天北疆环线**：\n\n#### 整体思路\n- **顺时针大环线**：乌鲁木齐 → 可可托海 → 喀纳斯/禾木 → 魔鬼城 → 赛里木湖 → 伊宁 → 特克斯，不走回头路\n- 上海往返飞机，**乌鲁木齐取车、伊宁还车**（异地还车费约 ¥600）\n- 按 relaxed 节奏，每天驾驶尽量控制在 5 小时内\n\n有一个问题需要你知道：**独库公路 5 月初大概率还没开放**（往年 6 月上旬通车）。我先按「特克斯+琼库什台」排了 D7 替代，你可以随时让我改。' },
    { type: 'ready_card', time: '04-24 20:09' },
    { type: 'assumption', time: '04-24 20:09', items: ['按 2 人 / 中等预算估算，可修改', '独库公路按往年 6 月上旬开放预估'] },
    { type: 'user', time: '04-26 21:08', text: '赛里木湖那天想早点环湖，下午留着发呆' },
    {
      type: 'tools', time: '04-26 21:10', status: 'done', collapsed: true,
      items: [
        { icon: 'car', title: '路径规划 · 奎屯→赛里木湖（到达时间重算）', result: '246 公里 / 2.5 小时 · 09:00 前可到', json: '{\n  "from":"奎屯","to":"赛里木湖",\n  "distanceKm":246,"minutes":150\n}' },
        { icon: 'search', title: '搜索「赛里木湖 上午 光线 环湖」', result: '5 条结果 · 上午顺光更适合拍照', json: '{\n  "conclusion": "环湖东岸上午顺光"\n}' }
      ]
    },
    { type: 'ai', time: '04-26 21:14', md: '已调整 **Day 5**（v7）：\n- 环湖自驾 `14:00–18:00` → `09:00–13:00`\n- 下午改为 **湖畔自由活动**（free），西海草原发呆\n- 毡房营地住宿不变\n\n地图上高亮的就是这次改动的部分。' }
  ];

  /* ---- 状态② 首次规划中（ask_user 待答 + 工具时间线进行中） ---- */
  const convoPlanning = [
    { type: 'user', time: '20:03', text: '马上五一了，我想去新疆旅游，给个推荐路线' },
    {
      type: 'ask_user', time: '20:03', answered: false,
      intro: '为了排出合适的路线，需要确认几件事',
      questions: [
        { question: '这趟大概几天？', multi: false, options: [{ id: 'd4', label: '4 天' }, { id: 'd6', label: '6 天' }, { id: 'd8', label: '8 天' }], noteHint: '例如：只有 5.1–5.4 有假' },
        { question: '从哪个城市出发？', multi: false, options: [{ id: 'sh', label: '上海' }, { id: 'bj', label: '北京' }, { id: 'gz', label: '广州' }, { id: 'other', label: '其他城市' }], noteHint: '影响机票与首末日安排' },
        { question: '当地交通方式？', multi: true, options: [{ id: 'drive', label: '自驾' }, { id: 'flight', label: '飞机' }, { id: 'train', label: '火车' }, { id: 'charter', label: '包车' }], noteHint: '例如：两人轮流开车' }
      ]
    },
    {
      type: 'tools', time: '20:04', status: 'running', collapsed: false,
      items: [
        { icon: 'search', title: '正在搜索「新疆 五一 推荐路线」…', status: 'running' },
        { icon: 'weather', title: '查询天气 · 北疆 5/1–5/8', status: 'done', result: '晴为主，昼夜温差大' },
        { icon: 'search', title: '搜索「独库公路 开放时间」', status: 'failed', result: '网络超时 · 将自动重试' }
      ]
    }
  ];

  /* ---- 状态③ 节点重规划中（@阿勒泰 · Day 3） ---- */
  const convoReplanning = [
    { type: 'user', time: '21:40', ctx: [{ label: '阿勒泰 · Day 3', stopId: 'd3s1', dayIndex: 3 }], text: '我起晚了，想下午再出发，重规划一下' },
    {
      type: 'ai', time: '21:40', md: '收到，针对 **Day 3（喀纳斯 → 禾木）** 局部重排：\n- 起床时间 `09:00` → **`13:00`**\n- 当天 4 个活动整体后移：阿勒泰午餐取消改为路上简餐，五彩滩**删除**\n- **三湾徒步取消**（时间不够，且与日落冲突——顺带解决了重叠警告）\n- **禾木日落观景保留** `19:40–21:30`，住宿不变\n\n只动 Day 3，其余 7 天不受影响。'
    },
    {
      type: 'tools', time: '21:41', status: 'running', collapsed: false,
      items: [
        { icon: 'car', title: '正在重算 可可托海→禾木 驾车路程…', status: 'running' },
        { icon: 'sun', title: '查询禾木 5/3 日落时间', status: 'done', result: '日落 21:23 · 观景台到位建议 19:40 前' }
      ]
    }
  ];

  /* ---- 流程 B 落地后的 Day 3 补丁（重规划完成态） ---- */
  const day3Patch = {
    rhythm: { wake: '13:00', sleep: '23:30' },
    removed: ['d3s1a2', 'd3s1a3', 'd3s2a1', 'd3s3a1'],
    diffTags: { d3s1: '09:00 → 13:00' },
    summary: { md: '**Day 3 已重排完成**（v8）：\n- 作息 `09:00` → `13:00`，删除五彩滩与三湾徒步\n- 阿勒泰简餐 `14:00–14:40`，直接进山\n- **禾木日落完整保留** `19:40–21:30`\n- 顺带消除了「三湾徒步×禾木日落」的时间重叠警告\n\n改动只涉及 Day 3 的 2 个 stop 与 3 条连线。' },
    newVersion: 8
  };

  /* ============================================================
     行程列表页数据
     ============================================================ */
  const tripList = [
    {
      tripId: 'xj-2026-wuyi', title: '新疆环线 · 五一自驾', dest: '北疆 · 乌鲁木齐–喀纳斯–伊犁',
      dateRange: '5月1日 – 5月8日', days: 8, transport: '自驾', version: 7, updatedAt: '04-26 21:14',
      conflicts: { error: 1, warning: 3 },
      thumbRoute: [[87.62, 43.79], [89.72, 47.19], [88.14, 47.85], [86.87, 47.80], [87.02, 48.72], [87.42, 48.83], [85.69, 46.10], [84.90, 44.43], [81.17, 44.61], [81.33, 43.92], [81.84, 43.21]]
    },
    {
      tripId: 'yn-2025-autumn', title: '滇东南 · 秋色环线', dest: '云南 · 昆明–建水–元阳–普者黑',
      dateRange: '10月2日 – 10月7日', days: 6, transport: '自驾', version: 12, updatedAt: '2025-09-28 10:02',
      conflicts: { error: 0, warning: 0 }, done: true,
      thumbRoute: [[102.83, 24.88], [102.41, 23.63], [102.83, 23.09], [104.72, 23.62], [104.19, 24.42]]
    },
    {
      tripId: 'jp-2025-kansai', title: '关西 · 神社与铁道', dest: '日本 · 大阪–京都–奈良–宇治',
      dateRange: '4月3日 – 4月9日', days: 7, transport: '火车', version: 5, updatedAt: '2025-03-20 22:47',
      conflicts: { error: 0, warning: 1 }, done: true,
      thumbRoute: [[135.50, 34.70], [135.76, 35.01], [135.83, 34.68], [135.81, 34.89], [135.63, 34.99]]
    },
    {
      tripId: 'zj-anji-weekend', title: '安吉 · 周末山野', dest: '浙江 · 安吉天荒坪–深溪',
      dateRange: '3月14日 – 3月15日', days: 2, transport: '自驾', version: 3, updatedAt: '2025-03-12 19:31',
      conflicts: { error: 0, warning: 0 }, done: true,
      thumbRoute: [[119.68, 30.54], [119.60, 30.63], [119.52, 30.58]]
    }
  ];

  /* ============================================================
     模型切换选项
     ============================================================ */
  const models = [
    { provider: 'DeepSeek', options: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', desc: '快速 · 1M 上下文' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', desc: '深度推理 · 强 Agent' }] },
    { provider: 'Qwen', options: [{ id: 'qwen3-max', name: 'Qwen3.8-Max', desc: '中文强 · 当前任务配置' }, { id: 'qwen-plus', name: 'Qwen-Plus', desc: '轻量' }] },
    { provider: 'Claude', options: [{ id: 'claude-sonnet', name: 'Claude Sonnet 5.5', desc: '工具调用稳' }, { id: 'claude-opus', name: 'Claude Opus 5.5', desc: '最强规划' }] },
    { provider: 'GPT', options: [{ id: 'gpt-5.2', name: 'GPT-5.2', desc: '通用' }] },
    { provider: '自定义兼容端点', options: [{ id: 'custom-oai', name: 'OpenAI-Compatible…', desc: '填写 Base URL + Key' }] }
  ];

  return {
    trip, derived, convoComplete, convoPlanning, convoReplanning, day3Patch,
    versionDiffs, tripList, models,
    currentModel: { provider: 'Qwen', id: 'qwen3-max', name: 'Qwen3.8-Max' }
  };
})();
