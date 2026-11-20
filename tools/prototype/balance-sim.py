"""参考实现：严格按 00-contracts（四境界）。突破后 qi=demon=0；缓存按 actionId 命中。"""
TICK = 0.1
def am(k): return 1/(1+0.25*(k-1))

def run(demon_base=0.00005, calm=True, cap_ticks=30000):
    plan=[(1,1,0,False),(3,3,5,True),(5,25,30,True),(8,100,150,True)]
    depth=[0,1,1,1]; th=[1e3,1e4,1.2e5,8e5]
    qi=0.0; demon=0.0; t=0.0; out=[]
    for i,(acts,rm,ps,jade) in enumerate(plan):
        st=t; fires=0; n=0
        while qi < th[i] and n < cap_ticks:
            seq=[]
            if calm and demon > 0.5 and acts >= 2: seq.append(('calm',1))
            for k in range(len(seq)+1, acts+1): seq.append(('breath',k))
            seen=set(); gain=0.0
            for aid,k in seq:
                if aid=='breath':
                    g=am(k)
                    if jade and aid in seen: g*=0.7
                    gain+=g*rm; demon+=demon_base*(1+0.5*depth[i]); seen.add(aid)
                else: demon=max(0.0,demon-0.0005)
            qi+=gain+ps*TICK
            if demon>=1.0: qi*=0.7; demon=0.0; fires+=1
            t+=TICK; n+=1
        out.append(dict(realm=i, rate=qi/(t-st), stage=t-st, total=t, fires=fires))
        qi=0.0; demon=0.0
    return out

def mm(s): s=round(s); return "%d:%02d"%(s//60,s%60)

if __name__ == "__main__":
    for b in (0.00004,0.00005,0.00006):
        print("base=%.5f | "%b + " | ".join("境%d %.0f/s 阶段%d:%02d 累计%d:%02d 走火%d"%(
            x["realm"],x["rate"],round(x["stage"])//60,round(x["stage"])%60,round(x["total"])//60,round(x["total"])%60,x["fires"]) for x in run(b)))
    print("不调息(乐观下界): " + " | ".join("境%d %.0f/s 累计%d:%02d 走火%d"%(
        x["realm"],x["rate"],round(x["total"])//60,round(x["total"])%60,x["fires"]) for x in run(calm=False)))
