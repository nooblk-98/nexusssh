ALTER TABLE "KubernetesCluster" ADD COLUMN "groupId" TEXT REFERENCES "ServerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "KubernetesCluster_groupId_idx" ON "KubernetesCluster"("groupId");
