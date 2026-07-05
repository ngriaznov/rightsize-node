import { defineConfig } from "vitepress";

export default defineConfig({
  title: "rightsize",
  description: "Testcontainers-style integration testing on microsandbox microVMs. No Docker required.",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "Modules", link: "/modules/" },
      { text: "GitHub", link: "https://github.com/ngriaznov/rightsize-node" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Lifecycle: await using", link: "/guide/lifecycle" },
          { text: "Backends", link: "/guide/backends" },
          { text: "Networking", link: "/guide/networking" },
          { text: "Wait strategies", link: "/guide/wait-strategies" },
          { text: "How it works", link: "/guide/how-it-works" },
          { text: "Configuration", link: "/guide/configuration" },
        ],
      },
      {
        text: "Modules",
        items: [
          { text: "Overview", link: "/modules/" },
          { text: "Redis", link: "/modules/redis" },
          { text: "Memcached", link: "/modules/memcached" },
          { text: "ArangoDB", link: "/modules/arango" },
          { text: "MongoDB", link: "/modules/mongodb" },
          { text: "PostgreSQL", link: "/modules/postgres" },
          { text: "MySQL", link: "/modules/mysql" },
          { text: "MariaDB", link: "/modules/mariadb" },
          { text: "Redpanda", link: "/modules/redpanda" },
          { text: "Kafka", link: "/modules/kafka" },
          { text: "RabbitMQ", link: "/modules/rabbitmq" },
          { text: "Apache Pinot", link: "/modules/pinot" },
          { text: "Spring Cloud Config", link: "/modules/spring-cloud-config" },
          { text: "WireMock", link: "/modules/wiremock" },
          { text: "Keycloak", link: "/modules/keycloak" },
          { text: "ClickHouse", link: "/modules/clickhouse" },
          { text: "Neo4j", link: "/modules/neo4j" },
          { text: "Floci", link: "/modules/floci" },
          { text: "Flink", link: "/modules/flink" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/ngriaznov/rightsize-node" }],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/ngriaznov/rightsize-node/edit/main/docs/:path",
    },
  },
});
