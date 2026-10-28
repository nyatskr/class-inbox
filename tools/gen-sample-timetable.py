# -*- coding: utf-8 -*-
"""生成完全虚构的样例课表（sample-timetable.xls）。

用途：仓库里需要一个能直接导入试的 .xls，但真实课表含学号、教学班编号、
班级名称等信息，不适合公开。这个脚本保留原表的**版式与字段顺序**，
把所有可识别信息替换成虚构内容，因此解析器回归测试仍然有效。

用法：
    pip install xlrd xlwt
    python tools/gen-sample-timetable.py

输入：需要一个「原始表」作为版式模板。默认读同目录的 .template.xls，
      没有的话用 --src 指定路径。
输出：class-inbox/sample-timetable.xls
"""

import argparse
import os
import re
import sys

try:
    import xlrd
    import xlwt
except ImportError:
    sys.exit("需要 xlrd 和 xlwt：pip install xlrd xlwt")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 原始 → 虚构。键按长度倒序匹配，避免「二区601」先吃掉「二区601(计算机基础实验室8)」。
REPLACE = {
    # 个人信息
    "张三的课表": "示例同学的课表",
    "20240000000": "00000000000",
    # 课程名
    "大学生职业发展与就业指导5": "创新创业基础",
    "计算机组成原理": "操作系统原理",
    "自然语言处理B": "编译原理",
    "大数据技术与应用": "软件工程导论",
    "中外哲学导论": "艺术鉴赏导论",
    "计算机图形学B": "数字媒体技术",
    "数字图像处理": "多媒体技术基础",
    "机器学习B": "数据挖掘导论",
    "高等数学1": "线性代数",
    "专业英语": "学术英语写作",
    "形势与政策5": "通识讲座",
    # 教学班编号
    "(2026-2027-1)-082267": "(2026-2027-1)-000001",
    "(2026-2027-1)-081138": "(2026-2027-1)-000002",
    "(2026-2027-1)-080550": "(2026-2027-1)-000003",
    "(2026-2027-1)-082269": "(2026-2027-1)-000004",
    "(2026-2027-1)-082268": "(2026-2027-1)-000005",
    "(2026-2027-1)-160243": "(2026-2027-1)-000006",
    "(2026-2027-1)-082232": "(2026-2027-1)-000007",
    "(2026-2027-1)-080074": "(2026-2027-1)-000008",
    "(2026-2027-1)-080556": "(2026-2027-1)-000009",
    "(2026-2027-1)-080226": "(2026-2027-1)-000010",
    # 班级组成
    "24计科3班": "25示例1班",
    "26计科1班": "25示例2班",
    # 地点
    "二区601(计算机基础实验室8)": "教学楼A-201(计算机基础实验室)",
    "实验楼124(网络原理实验室)": "实训楼D-102(网络实验室)",
    "四区324(北)": "教学楼B-107",
    "四区402(南)": "教学楼C-302",
    "四区422(北)": "教学楼C-303",
    "四区308(南)": "教学楼C-304",
    "四区223(北)": "教学楼C-305",
    "二区601": "教学楼A-202",
    "二区612": "教学楼A-203",
    "三区303": "教学楼B-105",
    "三区301": "教学楼B-101",
    "一区409": "教学楼C-301",
    "一区109": "教学楼C-101",
    "二区510": "教学楼A-305",
    "二区401": "教学楼A-401",
    "实验楼214": "实训楼D-201",
    # 教师（一次扫描替换，不会连锁）
    "沈老师": "陈老师",
    "方老师": "林老师",
    "孙老师": "黄老师",
    "何老师": "吴老师",
    "管老师": "郑老师",
    "吴老师": "许老师",
    "马老师": "周老师",
    "丁老师": "徐老师",
    "周老师": "高老师",
    "薛老师": "梁老师",
}

PATTERN = re.compile("|".join(re.escape(k) for k in sorted(REPLACE, key=len, reverse=True)))


def scrub(text):
    return PATTERN.sub(lambda m: REPLACE[m.group(0)], text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(HERE, ".template.xls"),
                    help="版式模板（原始表），默认 tools/.template.xls")
    ap.add_argument("--out", default=os.path.join(ROOT, "sample-timetable.xls"))
    args = ap.parse_args()

    if not os.path.exists(args.src):
        sys.exit(
            "找不到版式模板：%s\n"
            "把一份原始课表放到这个路径（或用 --src 指定），再运行。\n"
            "模板不会被提交到仓库——它含真实信息。" % args.src
        )

    book = xlrd.open_workbook(args.src)
    out = xlwt.Workbook(encoding="utf-8")
    total = 0
    for sh in book.sheets():
        ws = out.add_sheet(sh.name)
        for r in range(sh.nrows):
            for c in range(sh.ncols):
                v = sh.cell_value(r, c)
                if isinstance(v, float) and v == int(v):
                    v = int(v)
                text = str(v)
                new = scrub(text)
                if new != text:
                    total += 1
                if new:
                    ws.write(r, c, new)
    out.save(args.out)
    print("已写出 %s（替换了 %d 个单元格）" % (args.out, total))


if __name__ == "__main__":
    main()
